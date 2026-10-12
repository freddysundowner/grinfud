// WhatsApp ordering conversation. LeadsIntel posts each incoming message to /webhooks/leadsintel;
// handle() returns the reply text, which the webhook sends straight back (HTTP 200 reply JSON).
//
// Flow: menu → item → its options → quantity → (add more | checkout) → name → location → time → notes → confirm.
// At the confirm step the customer can still change the items, name, location, time or notes.
// Commands at any time: MENU, BASKET, REORDER, STATUS, CANCEL, CANCEL ORDER, USERNAME, AGENT, HELP.

const IDLE_RESET_MS = 3 * 60 * 60 * 1000;
const FRESH = () => ({ step: 'idle', cart: [] });

module.exports = function createChat({ db, getSettings, visibleItems, priceCart, createOrder, money, safeJSON, trackUrl, onOrderCancelled, onAgentRequest }) {
  const load = async phone => {
    const r = await db.one('SELECT * FROM chats WHERE phone = $1', [phone]);
    if (!r || Date.now() - Number(r.updated_at) > IDLE_RESET_MS) return FRESH();
    const st = safeJSON(r.state_json, FRESH());
    return st && Array.isArray(st.cart) ? st : FRESH();
  };
  const save = (phone, st) => db.q('INSERT INTO chats (phone, state_json, updated_at) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at',
    [phone, JSON.stringify(st), Date.now()]);
  const lastOrder = phone => db.one('SELECT * FROM orders WHERE phone = $1 ORDER BY id DESC LIMIT 1', [phone]);

  const site = () => require('./public-urls').origin() ? `\nOr order online: ${require('./public-urls').origin()}` : '';
  const STATUS = { new: 'received ✅', preparing: 'being prepared 🍳', out_for_delivery: 'on its way 🛵', delivered: 'delivered 🎉', cancelled: 'cancelled' };
  const HELP = `Here is what you can send me:\n\n*MENU* — see what we have and order\n*BASKET* — see or change your basket\n*REORDER* — same as your last order\n*STATUS* — track your order\n*CANCEL ORDER* — cancel an order you placed\n*CANCEL* — start over\n*USERNAME* — pick a nickname\n*AGENT* — talk to a person`;
  const GREETINGS = ['hi', 'hello', 'hey', 'hallo', 'helo', 'start', 'habari', 'sasa', 'niaje', 'mambo', 'good morning', 'good afternoon', 'good evening'];
  const AGENT_WORDS = ['agent', 'human', 'person', 'call me', 'talk', 'support', 'customer care', 'speak to someone', 'talk to someone', 'talk to a person'];

  // "KSh 50 / bunch · raw · serves 4 · min 5"
  const PREP = { cooked: 'cooked', raw: 'raw', both: 'cooked or raw' };
  const facts = (it, s) => [money(it.price, s) + (it.unit ? ` / ${it.unit}` : ''), PREP[it.prep], it.serves ? `serves ${it.serves}` : '', it.min_qty > 1 ? `min ${it.min_qty}` : ''].filter(Boolean).join(' · ');
  const qtyPrompt = it => `How many${it && it.unit ? ` (${it.unit})` : ''} would you like? (${it ? it.min_qty : 1}–20)`;
  function menuText(s) {
    const items = visibleItems();
    if (!items.length) return `Our menu is being updated. Please check back soon.${site()}`;
    // Grouped by category, numbered straight through, so "3" always means the same dish.
    let n = 0; const cats = [...new Set(items.map(i => i.category || 'Menu'))];
    return `*${s.business_name} menu* 🧺\n\n` + cats.map(c => (cats.length > 1 ? `— ${c.toUpperCase()} —\n` : '') + items.filter(i => (i.category || 'Menu') === c)
      .map(it => `*${++n}.* ${it.name} — ${facts(it, s)}${it.description ? `\n    _${it.description}_` : ''}`).join('\n\n')).join('\n\n') +
      `\n\nReply with a *number* to order.${site()}`;
  }
  const lineText = (l, s) => `${l.qty} × ${l.name}${l.options.length ? ` (${l.options.map(o => o.choice).join(', ')})` : ''} — ${money(l.line_total, s)}`;
  function basketText(st, s) {
    if (!st.cart.length) return 'Your basket is empty.';
    let p; try { p = priceCart(st.cart); } catch (e) { return e.message; }
    return '*Your basket*\n' + p.lines.map(l => `• ${lineText(l, s)}`).join('\n') +
      (p.delivery_fee ? `\nDelivery: ${money(p.delivery_fee, s)}` : '') + `\n*Total: ${money(p.total, s)}*`;
  }
  const BASKET_ACTIONS = '*1.* Add something else\n*2.* Checkout\n*3.* Empty basket\n*4.* Remove one item';
  function removePrompt(st, s) {
    let p; try { p = priceCart(st.cart); } catch (e) { return e.message; }
    return '*Which item should I remove?*\n' + p.lines.map((l, i) => `*${i + 1}.* ${lineText(l, s)}`).join('\n') + '\n\nReply with a number, or *0* to keep everything.';
  }
  function optionPrompt(item, gi) {
    const g = item.options[gi];
    return `*${g.name}*\n` + g.choices.map((c, i) => `*${i + 1}.* ${c.label}${c.price ? ` (+${money(c.price, getSettings())})` : ''}`).join('\n') +
      (g.type === 'multi' ? `\n\nReply with numbers, e.g. *1,3*${g.required ? '' : ' — or *0* for none'}.` : `\n\nReply with a number${g.required ? '' : ' — or *0* to skip'}.`);
  }
  // A reply can be the number in the list or (part of) the name, e.g. "2" or "ngwaci".
  function pick(list, text, label) {
    const t = text.trim().toLowerCase(); if (!t) return null;
    if (/^\d+$/.test(t)) return list[Number(t) - 1] || null;
    const exact = list.filter(x => label(x).toLowerCase() === t); if (exact.length === 1) return exact[0];
    const part = t.length >= 3 ? list.filter(x => label(x).toLowerCase().includes(t)) : [];
    return part.length === 1 ? part[0] : null;
  }
  const afterAdd = (st, s) => `Added ✅\n\n${basketText(st, s)}\n\n${BASKET_ACTIONS}`;
  function whenOptions(s) {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    const iso = d.toISOString().slice(0, 10); const label = d.toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });
    return safeJSON(s.delivery_times, []).map(t => ({ date: iso, time: t, label: `Tomorrow (${label}), ${t}` }));
  }
  function whenPrompt(s) {
    const opts = whenOptions(s);
    return '*When should we deliver?*\n' + opts.map((o, i) => `*${i + 1}.* ${o.label}`).join('\n') + `\n\n${opts.length ? 'Reply with a number, or type' : 'Type'} another day and time.`;
  }
  function confirmText(st, s) {
    return `*Please confirm your order*\n\n${basketText(st, s)}\n\n👤 ${st.name}\n📍 ${st.location}${st.pin ? ' (pin added ✅)' : ''}\n🕖 ${[st.delivery_date, st.delivery_time].filter(Boolean).join(', ')}` +
      (st.notes ? `\n✎ ${st.notes}` : '') + (s.payment_note ? `\n\n${s.payment_note}` : '') + `\n\n*1.* Confirm order\n*2.* Change something\n*3.* Cancel`;
  }
  const CHANGE_MENU = '*What would you like to change?*\n*1.* Items in the basket\n*2.* Name\n*3.* Delivery location\n*4.* Delivery time\n*5.* Notes\n*0.* Nothing, go back';
  // The buyer's own tracking page. Only shown when it is a full link (PUBLIC_URL set), since a bare path is no use in a chat.
  const track = (url, lead) => (/^https?:/.test(url || '') ? `${lead} ${url}\n` : '');
  const nums = t => (String(t).match(/\d+/g) || []).map(Number);
  const pinOf = L => { const a = Number(L.latitude), b = Number(L.longitude); return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0) ? { lat: a, lng: b } : null; };
  const haveDetails = st => !!(st.name && st.location && st.delivery_time);
  // "Side questions" (cancel an order, pick a nickname) remember where the customer was and return there.
  const SIDE = ['cancel_order', 'username'];

  // One message at a time per customer, so two quick messages can't both read the same basket and overwrite each other.
  const queues = new Map();
  function handle(phone, input) {
    const turn = (queues.get(phone) || Promise.resolve()).catch(() => {}).then(() => handleNow(phone, input));
    queues.set(phone, turn);
    const clear = () => { if (queues.get(phone) === turn) queues.delete(phone); };
    turn.then(clear, clear);
    return turn;
  }

  async function handleNow(phone, input) {
    const s = getSettings();
    let st = await load(phone);
    const text = (input.text || '').trim();
    const cmd = text.toLowerCase().replace(/[!.?]+$/, '').replace(/\s+/g, ' ');
    const reply = async r => { await save(phone, st); return r; };
    // After changing one detail from the confirm screen, go straight back to it.
    const next = (step, prompt) => { if (st.fix) { delete st.fix; st.step = 'confirm'; return reply(confirmText(st, s)); } st.step = step; return reply(prompt()); };
    // After a side question, remind someone who was part-way through an order where they were.
    const resume = () => (st.step !== 'idle' ? `\n\nYou were in the middle of an order — just answer the last question, or send *BASKET* to see it.` : '');
    const aside = step => { if (!SIDE.includes(st.step)) st.back = st.step; st.step = step; };

    // ---- commands that work at any point ----
    if (['help', '?', 'commands', 'options'].includes(cmd)) return reply(`${HELP}${site()}`);

    if (AGENT_WORDS.includes(cmd)) {
      if (onAgentRequest) onAgentRequest(phone, st.name || '');
      return reply(`No problem 🙂 I've told our team you'd like to talk to a person. You can also call or WhatsApp us on *+${String(s.notify_phone).split(',')[0]}*.${st.cart.length ? '\n\nYour basket is kept — send *BASKET* to carry on.' : ''}`);
    }

    if (['status', 'track', 'my order', 'order status', 'where is my order'].includes(cmd) || /^gf-\d+$/i.test(cmd)) {
      const o = /^gf-/i.test(cmd) ? await db.one('SELECT * FROM orders WHERE code = $1 AND phone = $2', [cmd.toUpperCase(), phone]) : await lastOrder(phone);
      return reply(o ? `Your order *${o.code}* is ${STATUS[o.status] || o.status}.${track(trackUrl(o.track_token), '\n📦 Follow it live:').replace(/\n$/, '')}${o.status === 'new' ? '\nSend *CANCEL ORDER* if you need to cancel it.' : ''}` : `I couldn't find an order for this number. Send *MENU* to order.`);
    }

    if (['cancel order', 'cancel my order', 'cancel the order'].includes(cmd) || /^cancel gf-\d+$/i.test(cmd)) {
      const code = (cmd.match(/gf-\d+/i) || [''])[0].toUpperCase();
      const o = code ? await db.one('SELECT * FROM orders WHERE code = $1 AND phone = $2', [code, phone]) : await lastOrder(phone);
      if (!o) return reply(`I couldn't find an order for this number. Send *MENU* to order.`);
      if (o.status === 'cancelled') return reply(`Your order *${o.code}* is already cancelled.`);
      if (o.status !== 'new') return reply(`Your order *${o.code}* is already ${STATUS[o.status] || o.status}, so I can't cancel it here. Please call or WhatsApp us on *+${String(s.notify_phone).split(',')[0]}*.`);
      aside('cancel_order'); st.cancel_code = o.code;
      return reply(`Cancel order *${o.code}* (${money(o.total, s)})?\n\n*1.* Yes, cancel it\n*2.* No, keep it`);
    }

    if (['username', 'nickname', 'my username', 'set username', 'change username'].includes(cmd)) {
      const c = await db.one('SELECT username FROM customers WHERE phone = $1', [phone]);
      aside('username');
      return reply(`${c && c.username ? `Your nickname is *${c.username}*.\n\n` : ''}Type the nickname you'd like us to use (2–30 characters).\nReply *0* to ${c && c.username ? 'remove it' : 'skip'}.`);
    }

    if (['cancel', 'stop', 'reset', 'start over', 'restart', 'clear'].includes(cmd)) {
      const had = st.cart.length || st.step !== 'idle';
      st = FRESH();
      if (!had) { const o = await lastOrder(phone); if (o && o.status === 'new') return reply(`There's nothing in progress. To cancel your order *${o.code}*, send *CANCEL ORDER*.`); }
      return reply(`Okay, I've cleared everything. Send *MENU* whenever you're ready.`);
    }

    if (['basket', 'cart', 'my basket', 'my cart', 'view basket'].includes(cmd)) {
      st.step = st.cart.length ? 'after_add' : 'idle';
      return reply(basketText(st, s) + (st.cart.length ? `\n\n${BASKET_ACTIONS}` : '\n\nSend *MENU* to order.'));
    }

    // ---- answers to a side question ----
    if (st.step === 'cancel_order') {
      const yes = text === '1' || /^(yes|ndio|y)$/i.test(text), no = text === '2' || /^(no|hapana|n)$/i.test(text);
      if (!yes && !no) return reply(`Reply *1* to cancel order ${st.cancel_code}, or *2* to keep it.`);
      const code = st.cancel_code; st.step = st.back || 'idle'; delete st.back; delete st.cancel_code;
      if (no) return reply(`Okay, order *${code}* stays as it is. 👍${resume()}`);
      const row = await db.one("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE code = $1 AND phone = $2 AND status = 'new' RETURNING *", [code, phone]);
      if (!row) return reply(`Order *${code}* is already being handled, so I can't cancel it here. Please call or WhatsApp us on *+${String(s.notify_phone).split(',')[0]}*.`);
      if (onOrderCancelled) onOrderCancelled(row);
      return reply(`Order *${code}* is cancelled.${resume() || ' Send *MENU* whenever you want to order again.'}`);
    }
    if (st.step === 'username') {
      const name = text.replace(/\s+/g, ' ').slice(0, 30);
      if (text !== '0' && name.length < 2) return reply('Please type a nickname of 2–30 characters, or *0* to skip.');
      st.step = st.back || 'idle'; delete st.back;
      const carryOn = resume() || ' Send *MENU* to order.';
      if (text === '0') { await db.q('UPDATE customers SET username = NULL WHERE phone = $1', [phone]); return reply(`Okay, no nickname.${carryOn}`); }
      await db.q('INSERT INTO customers (phone, username, source) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET username = excluded.username', [phone, name, 'whatsapp']);
      return reply(`Nice to meet you, *${name}*! 🙂${carryOn}`);
    }

    if (s.accepting_orders !== '1') { st = FRESH(); return reply(`${s.closed_message}${site()}`); }

    if (['reorder', 're-order', 'same again', 'repeat', 'repeat order', 'the usual', 'same as last time'].includes(cmd)) {
      const o = await lastOrder(phone);
      if (!o) { st.step = 'pick_item'; return reply(`You haven't ordered with this number yet.\n\n${menuText(s)}`); }
      const cart = safeJSON(o.items_json, []).map(l => ({ item_id: l.item_id, name: l.name, qty: l.qty,
        options: (l.options || []).reduce((m, op) => { (m[op.group] = m[op.group] || []).push(op.choice); return m; }, {}) }));
      try { priceCart(cart); } catch (e) { st.step = 'pick_item'; return reply(`I couldn't repeat your last order: ${e.message}\n\n${menuText(s)}`); }
      st = { step: 'when', cart, name: o.customer_name, location: o.location };
      return reply(`Same as last time 👍\n\n${basketText(st, s)}\n\n👤 ${st.name}\n📍 ${st.location}\n\n${whenPrompt(s)}`);
    }

    const greeting = GREETINGS.includes(cmd);
    if (cmd === 'menu' || greeting || st.step === 'idle') {
      if (greeting && st.cart.length) { st.step = 'after_add'; return reply(`Welcome back 👋 You still have a basket.\n\n${basketText(st, s)}\n\n${BASKET_ACTIONS}`); }
      const fromIdle = st.step === 'idle';
      st.step = 'pick_item';
      // Someone who opens with the name of a dish goes straight to it; everyone else sees the menu.
      const named = fromIdle && cmd !== 'menu' && !greeting && !/^\d+$/.test(cmd) && pick(visibleItems(), text, i => i.name);
      if (!named) {
        const hello = st.cart.length ? '' : `Hello 👋 Welcome to *${s.business_name}* — ${s.tagline}.\n\n`;
        return reply(hello + menuText(s) + (st.cart.length ? '' : '\n\nSend *HELP* to see everything I can do.'));
      }
    }

    const items = visibleItems();
    switch (st.step) {
      case 'pick_item': {
        const item = pick(items, text, i => i.name);
        if (!item) return reply(`Please reply with a number from the menu (1–${items.length}).\n\n${menuText(s)}`);
        st.cur = { item_id: item.id, name: item.name, options: {}, gi: 0 };
        if (item.options.length) { st.step = 'pick_option'; return reply(`*${item.name}* — ${facts(item, s)}\n\n${optionPrompt(item, 0)}`); }
        st.step = 'qty'; return reply(`*${item.name}* — ${facts(item, s)}\n\n${qtyPrompt(item)}`);
      }
      case 'pick_option': {
        const item = st.cur && items.find(i => i.id === st.cur.item_id); if (!item) { st.step = 'pick_item'; return reply(`Sorry, that item is no longer available.\n\n${menuText(s)}`); }
        const g = item.options[st.cur.gi]; if (!g) { st.step = 'qty'; return reply(qtyPrompt(item)); }
        const picks = nums(text);
        let chosen;
        if (picks.length === 1 && picks[0] === 0 && !g.required) chosen = [];
        else if (!picks.length) {
          // typed instead of numbered: "ngwaci" or, for choose-any, "avocado, honey"
          const parts = (g.type === 'multi' ? text.split(/,|&|\band\b/i) : [text]).map(x => x.trim()).filter(Boolean);
          const found = parts.map(p => pick(g.choices, p, c => c.label));
          if (!found.length || found.some(c => !c)) return reply(`Please choose from the list.\n\n${optionPrompt(item, st.cur.gi)}`);
          chosen = [...new Set(found.map(c => c.label))];
        } else {
          chosen = [...new Set(picks)].map(i => g.choices[i - 1]).filter(Boolean).map(c => c.label);
          if (!chosen.length || chosen.length !== new Set(picks).size) return reply(`Please choose from the list.\n\n${optionPrompt(item, st.cur.gi)}`);
        }
        if (g.type === 'single' && chosen.length > 1) return reply(`Please choose just one.\n\n${optionPrompt(item, st.cur.gi)}`);
        st.cur.options[g.name] = chosen; st.cur.gi++;
        if (st.cur.gi < item.options.length) return reply(optionPrompt(item, st.cur.gi));
        st.step = 'qty'; return reply(qtyPrompt(item));
      }
      case 'qty': {
        if (!st.cur) { st.step = 'pick_item'; return reply(menuText(s)); }
        const q = nums(text)[0];
        const cur = items.find(i => i.id === st.cur.item_id), min = cur ? cur.min_qty : 1;
        if (!(q >= min && q <= 20)) return reply(`Please reply with a quantity between ${min} and 20.${min > 1 ? ` The smallest order for ${st.cur.name} is ${min}.` : ''}`);
        st.cart.push({ item_id: st.cur.item_id, name: st.cur.name, qty: q, options: st.cur.options }); delete st.cur;
        try { priceCart(st.cart); } catch (e) { st.cart.pop(); st.step = 'pick_item'; return reply(`${e.message}\n\n${menuText(s)}`); }
        st.step = 'after_add'; return reply(afterAdd(st, s));
      }
      case 'after_add': {
        if (!st.cart.length) { st.step = 'pick_item'; return reply(menuText(s)); }
        const n = nums(text)[0];
        if (n === 1 || /^(add|more)/i.test(text)) { st.step = 'pick_item'; return reply(menuText(s)); }
        if (n === 3 || /^empty/i.test(text)) { st = FRESH(); return reply('Your basket is empty now. Send *MENU* to start again.'); }
        if (n === 4 || /^remove/i.test(text)) {
          if (st.cart.length === 1) { st = FRESH(); return reply('Removed. Your basket is empty now. Send *MENU* to start again.'); }
          st.step = 'remove_item'; return reply(removePrompt(st, s));
        }
        if (n !== 2 && !/^(checkout|check out|pay|done|finish)/i.test(text)) return reply('Reply *1* to add something else, *2* to checkout, *3* to empty your basket or *4* to remove one item.');
        try { priceCart(st.cart); } catch (e) { st = FRESH(); return reply(`${e.message}\n\nI've emptied your basket. Send *MENU* to start again.`); }
        if (haveDetails(st)) { delete st.fix; st.step = 'confirm'; return reply(confirmText(st, s)); }
        const prev = await lastOrder(phone);
        st.step = 'name';
        if (prev) { st.prev = { name: prev.customer_name, location: prev.location }; return reply(`Great! What name should we use?\n\n*1.* ${prev.customer_name}\nOr type a different name.`); }
        return reply('Great! What is your *name*?');
      }
      case 'remove_item': {
        const n = /^\d+$/.test(text) ? Number(text) : NaN;
        if (n === 0) { st.step = 'after_add'; return reply(`${basketText(st, s)}\n\n${BASKET_ACTIONS}`); }
        if (!st.cart[n - 1]) return reply(removePrompt(st, s));
        st.cart.splice(n - 1, 1); st.step = 'after_add';
        return reply(`Removed ✅\n\n${basketText(st, s)}\n\n${BASKET_ACTIONS}`);
      }
      case 'name': {
        const name = (text === '1' && st.prev) ? st.prev.name : text.slice(0, 80);
        if (name.length < 2) return reply('Please type your name.');
        st.name = name;
        return next('location', () => `Thanks, ${name.split(' ')[0]}! Where should we deliver?\n\nType the Airbnb or office name, building and unit/floor, or share your 📍 location.` + (st.prev ? `\n\n*1.* ${st.prev.location}` : ''));
      }
      case 'location': {
        // A shared pin at this point: keep it, then ask for the part a pin can't say (which building, which door).
        if (input.location && pinOf(input.location)) {
          st.pin = pinOf(input.location); st.location = [input.location.name, input.location.address].filter(Boolean).join(', ').slice(0, 300) || 'Pinned location';
          st.step = 'pin_detail'; return reply('Got your pin 📍 Thank you!\n\nNow type the *Airbnb or office name, building and unit/floor* so the rider knows which door.\nReply *0* to skip.');
        }
        const loc = (text === '1' && st.prev) ? st.prev.location : text.slice(0, 300);
        if (loc.trim().length < 4) return reply('Please type your delivery location or share your 📍 location.');
        st.location = loc.trim();
        if (st.pin) return next('when', () => whenPrompt(s)); // already pinned (changing the address from the confirm screen)
        st.step = 'pin'; return reply(`Thanks! Would you like to add a *location pin* 📍 so the rider finds you without calling?\n\n*1.* Yes, show me how\n*2.* No, the address is enough`);
      }
      case 'pin_detail': {
        if (input.location && pinOf(input.location)) { st.pin = pinOf(input.location); return reply('Pin updated 📍 Now type the building and unit/floor, or reply *0* to skip.'); }
        if (text !== '0' && text.length < 2) return reply('Please type the building and unit/floor, or reply *0* to skip.');
        if (text !== '0') st.location = (st.location === 'Pinned location' ? text : `${text} (${st.location})`).slice(0, 300);
        return next('when', () => whenPrompt(s));
      }
      case 'pin': case 'pin_wait': {
        if (input.location && pinOf(input.location)) { st.pin = pinOf(input.location); const ok = 'Got your pin 📍 Thank you!'; if (st.fix) { delete st.fix; st.step = 'confirm'; return reply(`${ok}\n\n${confirmText(st, s)}`); } st.step = 'when'; return reply(`${ok}\n\n${whenPrompt(s)}`); }
        const yes = text === '1' || /^(yes|ndio|y|ok|okay|sawa|sure)/i.test(text), no = text === '2' || text === '0' || /^(no|hapana|n|skip|later)/i.test(text);
        if (no) return next('when', () => whenPrompt(s));
        if (yes || st.step === 'pin_wait') { st.step = 'pin_wait'; return reply(`${yes ? 'Easy 👍' : `I'm waiting for your pin 📍`} In this chat:\n\n1️⃣ Tap the *📎 paperclip* (Android) or the *+* (iPhone) next to the message box\n2️⃣ Tap *Location*\n3️⃣ Tap *Send your current location*\n\nIf you're not there right now, move the map to the right place first.\nReply *0* to skip — you can also add the pin later from your order's tracking link.`); }
        return reply('Reply *1* and I\'ll show you how to send a pin, or *2* to carry on without one.');
      }
      case 'when': {
        const opts = whenOptions(s); const n = /^\d+$/.test(text) ? Number(text) : NaN;
        if (opts[n - 1]) { st.delivery_date = opts[n - 1].date; st.delivery_time = opts[n - 1].time; }
        else if (text.length >= 2 && Number.isNaN(n)) { st.delivery_date = ''; st.delivery_time = text.slice(0, 60); }
        else return reply(whenPrompt(s));
        return next('notes', () => 'Any notes for us? (gate code, call on arrival…)\nReply *0* for none.');
      }
      case 'notes': {
        if (!text) return reply('Please type your note, or reply *0* for none.');
        st.notes = text === '0' || /^(no|none|nope|hapana|nothing)$/i.test(text) ? '' : text.slice(0, 500);
        delete st.fix; st.step = 'confirm'; return reply(confirmText(st, s));
      }
      case 'confirm': {
        if (!st.cart.length || !haveDetails(st)) { st.step = st.cart.length ? 'after_add' : 'pick_item'; return reply(st.cart.length ? `${basketText(st, s)}\n\n${BASKET_ACTIONS}` : menuText(s)); }
        const n = /^\d+$/.test(text) ? Number(text) : NaN;
        if (n === 3 || /^(no|cancel|hapana)$/i.test(text)) { st = FRESH(); return reply('Order cancelled. Send *MENU* whenever you want to order again.'); }
        if (n === 2 || /^(change|edit)/i.test(text)) { st.step = 'change'; return reply(CHANGE_MENU); }
        if (n !== 1 && !/^(yes|confirm|ok|okay|ndio|sawa)/i.test(text)) return reply('Reply *1* to confirm, *2* to change something or *3* to cancel.');
        try {
          const o = await createOrder({ customer_name: st.name, phone, location: st.location, delivery_date: st.delivery_date, delivery_time: st.delivery_time, notes: st.notes, items: st.cart, lat: st.pin && st.pin.lat, lng: st.pin && st.pin.lng }, 'whatsapp');
          st = FRESH();
          return reply(`🎉 *Order confirmed!*\n\nYour order number is *${o.code}*.\nTotal: *${money(o.total, s)}*\nWe'll deliver to ${o.location}${o.delivery_date ? ` on ${o.delivery_date}` : ''}${o.delivery_time ? `, ${o.delivery_time}` : ''}.\n\n${s.payment_note ? s.payment_note + '\n' : ''}${track(o.track_url, '📦 Track your order here:')}Send *STATUS* any time, or *CANCEL ORDER* if your plans change. Thank you! 🧺`);
        } catch (e) {
          if (e.code) throw e; // a fault on our side: let LeadsIntel retry rather than tell the customer something untrue
          st.step = 'after_add'; return reply(`Sorry — ${e.message}\n\nReply *2* to try checkout again or *MENU* to change your order.`);
        }
      }
      case 'change': {
        const n = /^\d+$/.test(text) ? Number(text) : NaN;
        if (n === 0) { st.step = 'confirm'; return reply(confirmText(st, s)); }
        if (n === 1) { st.step = 'after_add'; return reply(`${basketText(st, s)}\n\n${BASKET_ACTIONS}`); }
        if (n === 2) { st.fix = true; st.step = 'name'; delete st.prev; return reply('What name should we use?'); }
        if (n === 3) { st.fix = true; st.step = 'location'; delete st.prev; delete st.pin; return reply('Where should we deliver?\n\nType the Airbnb or office name, building and unit/floor, or share your 📍 location.'); }
        if (n === 4) { st.fix = true; st.step = 'when'; return reply(whenPrompt(s)); }
        if (n === 5) { st.step = 'notes'; return reply('Type your note for us, or reply *0* for none.'); }
        return reply(CHANGE_MENU);
      }
      default: st = FRESH(); st.step = 'pick_item'; return reply(menuText(s));
    }
  }

  // Extract what we need from one Meta "message" object.
  function parseMessage(m) {
    if (!m || !m.from) return null;
    const t = m.type;
    if (t === 'text') return { text: m.text && m.text.body };
    if (t === 'button') return { text: m.button && (m.button.text || m.button.payload) };
    if (t === 'interactive') { const i = m.interactive || {}; return { text: (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '' }; }
    if (t === 'location') return { text: '', location: m.location || {} };
    return { unsupported: true };
  }

  return { handle, parseMessage };
};
