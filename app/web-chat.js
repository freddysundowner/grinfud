// Browser conversations are isolated by an opaque, HttpOnly session cookie.
// A typed phone number is delivery contact information, never authorization.
const crypto = require('crypto');
const ai = require('./ai');
const multer = require('multer');
const TTL = 3 * 60 * 60 * 1000;
module.exports = function mountWebChat(app, { db, publicMenu, whatsappUrl, priceCart, createOrder, rowToOrder, normPhone, validPhone, rateLimited, wrap, notifyCancelled, requestAgent }) {
  const busy = new Set(), rates = new Map();
  const buttons = (...pairs) => pairs.map(([label, value]) => ({ label, value }));
  const standard = () => buttons(['Menu', 'MENU'], ['My order', 'BASKET'], ['My orders', 'ORDERS'], ['Talk to the team', 'AGENT']);
  const fresh = () => ({ step: 'menu', cart: [], messages: [], requests: [], suggestions: [] });
  const add = (st, role, text) => {
    st.messages.push({ id: crypto.randomUUID(), role, text, at: Date.now() });
    st.messages = st.messages.slice(-80);
  };
  const save = (key, st) => db.q('INSERT INTO chats (phone,state_json,updated_at) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at', [key, JSON.stringify(st), Date.now()]);
  const load = async key => {
    const r = await db.one('SELECT state_json,updated_at FROM chats WHERE phone=$1', [key]);
    if (!r || Date.now() - Number(r.updated_at) > TTL) return fresh();
    return JSON.parse(r.state_json);
  };
  function session(req, res, create) {
    let token = (req.headers.cookie || '').match(/(?:^|;\s*)gf_webchat=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!token && create) token = crypto.randomBytes(32).toString('hex');
    if (!token) return null;
    res.setHeader('Set-Cookie', `gf_webchat=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL / 1000}${req.secure ? '; Secure' : ''}`);
    return 'web:' + crypto.createHash('sha256').update(token).digest('hex');
  }
  function guard(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    if (!publicMenu().website_chat_enabled) return res.status(403).json({ error: 'Website chat is currently turned off.' });
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Please chat from the GrinFud website.' });
    const now = Date.now();
    const bucket = rates.get(req.ip) || { start: now, count: 0 };
    if (now - bucket.start > 60000) { bucket.start = now; bucket.count = 0; }
    bucket.count++; rates.set(req.ip, bucket);
    if (bucket.count > 90) return res.status(429).json({ error: 'Please wait a minute before sending more messages.' });
    next();
  }
  setInterval(() => { for (const [ip, b] of rates) if (Date.now() - b.start > 60000) rates.delete(ip); }, 60000).unref();
  // Website shoppers already have the visual storefront menu. Keep its item
  // shortcuts out of the composer; retain option/quantity/confirmation controls.
  // Filter only the website response, leaving WhatsApp and stored state intact.
  const result = st => ({ business_name: publicMenu().business_name, whatsapp_url: whatsappUrl(), ai_available: ai.available(), messages: st.messages, suggestions: st.suggestions.filter(s => st.step !== 'menu' || !/^\d+$/.test(s.value)) });
  const money = n => `${publicMenu().currency} ${Number(n).toLocaleString('en-KE')}`;
  function menu(st) {
    const m = publicMenu();
    st.step = 'menu';
    st.menuIds = m.items.map(i => i.id);
    st.suggestions = m.items.slice(0, 6).map((i, n) => ({ label: i.name, value: String(n + 1) }));
    if (st.cart.length) st.suggestions.push({ label: 'My order', value: 'BASKET' });
    if (!m.accepting_orders) return m.closed_message || 'We are not taking orders right now.';
    return m.items.length ? `What would you like?\n\n${m.items.map((i, n) => `${n + 1}. ${i.name} — ${money(i.price)}${i.unit ? ' / ' + i.unit : ''}`).join('\n')}\n\nChoose a dish or type its number.` : 'Our menu is being updated. Please check back soon.';
  }
  function basket(st) {
    st.step = 'basket';
    st.suggestions = buttons(['Add more', 'MENU'], ['Checkout', 'CHECKOUT'], ['Start over', 'CANCEL']);
    if (!st.cart.length) { st.suggestions = standard(); return 'Your basket is empty. Send MENU to choose something.'; }
    const p = priceCart(st.cart);
    return `${p.lines.map((l, n) => `${n + 1}. ${l.qty} × ${l.name}${l.options.length ? ' (' + l.options.map(o => o.choice).join(', ') + ')' : ''} — ${money(l.line_total)}`).join('\n')}\nDelivery: ${money(p.delivery_fee)}\nTotal: ${money(p.total)}\n\nCheckout, add more, or type REMOVE followed by the line number.`;
  }
  function options(st) {
    const item = publicMenu().items.find(i => i.id === st.draft.item_id);
    if (!item) { delete st.draft; return 'That item is no longer available.\n\n' + menu(st); }
    const group = item.options[st.group];
    if (!group) {
      if (st.draft.qty) {
        priceCart([st.draft]); st.cart.push(st.draft); delete st.draft;
        return 'Added to your basket.\n\n' + basket(st);
      }
      st.step = 'quantity';
      st.suggestions = [item.min_qty, item.min_qty + 1, item.min_qty + 2].filter(n => n <= 50).map(n => ({ label: String(n), value: String(n) }));
      return `How many ${item.unit || 'portions'} of ${item.name}? Minimum ${item.min_qty}, maximum 50.`;
    }
    st.step = 'options';
    st.suggestions = group.type === 'multi' ? [] : group.choices.map((c, n) => ({ label: c.label, value: String(n + 1) }));
    if (!group.required) st.suggestions.push({ label: 'Skip', value: '0' });
    return `${group.name}\n\n${group.choices.map((c, n) => `${n + 1}. ${c.label}${c.price ? ' (+ ' + money(c.price) + ')' : ''}`).join('\n')}\n\n${group.type === 'multi' ? 'Type one or more numbers separated by commas.' : 'Choose one option.'}${group.required ? '' : ' Type 0 to skip.'}`;
  }
  function confirm(st) {
    const p = priceCart(st.cart);
    st.step = 'confirm'; st.quotedTotal = p.total;
    st.suggestions = buttons(['Confirm order', 'CONFIRM'], ['Change details', 'CHECKOUT'], ['Change basket', 'BASKET'], ['Start over', 'CANCEL']);
    return `Please check your order:\n\n${p.lines.map(l => `${l.qty} × ${l.name}${l.options.length ? ' (' + l.options.map(o => o.choice).join(', ') + ')' : ''} — ${money(l.line_total)}${l.note ? '\nItem note: ' + l.note : ''}`).join('\n')}\nDelivery: ${money(p.delivery_fee)}\nTotal: ${money(p.total)}\n\nName: ${st.details.customer_name}\nPhone: +${st.details.phone}\nDeliver to: ${st.details.location}\nWhen: ${st.details.delivery_time}\nDelivery notes: ${st.details.notes || 'None'}\n\nReply CONFIRM, or tap Confirm order, only when everything is correct.`;
  }
  function nextDetails(st) {
    st.details ||= {};
    if (st.senderPhone) st.details.phone = st.senderPhone;
    st.suggestions = [];
    if (!st.details.customer_name) { st.step = 'name'; return 'What name should we put on your order?'; }
    if (!st.details.phone) { st.step = 'phone'; return 'What Kenyan phone number can the delivery team contact? For example, 0712 345 678.'; }
    if (!st.details.location) { st.step = 'address'; return 'Where should we deliver? Include the area, building and unit or floor.'; }
    if (!st.details.delivery_time) {
      st.step = 'time'; st.suggestions = publicMenu().delivery_times.map(t => ({ label: String(t), value: String(t) }));
      return 'When would you like delivery? Choose a slot or type a date and time.';
    }
    if (!('notes' in st.details)) { st.step = 'notes'; st.suggestions = buttons(['No notes', '0']); return 'Any delivery notes? Type 0 for none.'; }
    return confirm(st);
  }
  const actions = require('./chat-actions')({ publicMenu, priceCart, normPhone, validPhone, basket, options, nextDetails });
  const tokens = st => [...new Set([...(st.orderTokens || []), st.lastToken].filter(Boolean))].slice(-10);
  async function ownedOrder(st, code) {
    return code
      ? db.one('SELECT * FROM orders WHERE code=$1 AND track_token=ANY($2::text[])', [code, tokens(st)])
      : st.lastToken ? db.one('SELECT * FROM orders WHERE track_token=$1', [st.lastToken]) : null;
  }
  async function smartAnswer(st, text, key, req) {
    if (/^PAY(?: GF-\d+)?$/i.test(text.trim())) return answer(st, text.trim(), key, req);
    if (/^(?:pay(?: now| with m-?pesa)?|m-?pesa|i want to pay|how (?:do|can) i pay)[?.!]*$/i.test(text.trim())) return answer(st, 'PAY', key, req);
    const fast = require('./chat-shortcuts')(text, st, publicMenu());
    if (fast !== null) return answer(st, fast, key, req);
    const cmd = text.toUpperCase();
    const shortcut = /^(MENU|HI|HELLO|HEY|BASKET|CHECKOUT|HELP|AGENT|CANCEL|START OVER|ORDERS|CONFIRM|CONFIRM CANCELLATION|KEEP ORDER|(?:STATUS|REORDER|CANCEL ORDER)(?: GF-\d+)?|REMOVE \d+)$/.test(cmd);
    const value = /^\d+(?:\s*,\s*\d+)*$/.test(text) || (st.step === 'phone' && validPhone(normPhone(text)));
    const explicitChoice = (st.suggestions || []).some(s => s.value === text);
    // Checkout fields are validated by the deterministic conversation flow.
    // A provider outage must never prevent a customer supplying delivery details.
    const checkoutField = ['name', 'phone', 'address', 'time', 'notes', 'confirm'].includes(st.step);
    if (shortcut || value || explicitChoice || checkoutField || !ai.available()) return answer(st, text, key, req);
    if (st.step === 'support_phone' && validPhone(normPhone(text))) return answer(st, text, key, req);
    st.aiOrders = tokens(st).length ? await db.q('SELECT code,status,total FROM orders WHERE track_token=ANY($1::text[]) ORDER BY id DESC LIMIT 10', [tokens(st)]) : [];
    const plan = await ai.interpret({ text, menu: publicMenu(), state: st, identity: req.ip });
    delete st.aiOrders;
    let action;
    try { action = actions.run(st, plan); }
    catch (e) { return e.message; }
    return action.command ? answer(st, action.command, key, req) : action.reply;
  }
  async function answer(st, text, key, req) {
    const cmd = text.trim().toUpperCase();
    if (/^PAY(?: GF-\d+)?$/.test(cmd)) {
      const order = await ownedOrder(st, cmd.split(' ')[1]);
      if (!order) return 'Confirm your order first, then you can pay from its private tracking page.';
      if (order.status === 'cancelled') return 'That order is cancelled and cannot be paid.';
      if (order.payment_status === 'completed') return `Order ${order.code} is already paid. View your receipt: /t/${order.track_token}`;
      const ready = (await db.one('SELECT enabled FROM sunpay_config WHERE id=1'))?.enabled && require('./credentials').status('sunpay').configured;
      return ready ? `Pay ${money(order.total)} for ${order.code}: /t/${order.track_token}\nTap Pay with M-Pesa to request the phone prompt. Enter your PIN only on your phone, never in this chat.`
        : 'Online M-Pesa payments are not enabled yet. Please contact the kitchen to arrange payment.';
    }
    if (/^STATUS(?: GF-\d+)?$/.test(cmd)) {
      const o = await ownedOrder(st, cmd.split(' ')[1]);
      st.suggestions = o ? buttons(['Reorder', `REORDER ${o.code}`], ['Cancel order', `CANCEL ORDER ${o.code}`], ['Menu', 'MENU']) : standard();
      return o ? `Order ${o.code}: ${o.status.replaceAll('_', ' ')}.\nTrack your order: /t/${o.track_token}` : 'I cannot find that order in this chat. Use the private tracking link for an order placed elsewhere.';
    }
    if (cmd === 'ORDERS') {
      const rows = await db.q('SELECT code,status,total FROM orders WHERE track_token=ANY($1::text[]) ORDER BY id DESC LIMIT 10', [tokens(st)]);
      st.suggestions = rows.length ? rows.map(o => ({ label: o.code, value: `STATUS ${o.code}` })) : standard();
      return rows.length ? 'Your orders from this chat:\n' + rows.map(o => `${o.code} — ${o.status.replaceAll('_', ' ')} — ${money(o.total)}`).join('\n') : 'No orders have been placed in this chat yet.';
    }
    if (/^REORDER(?: GF-\d+)?$/.test(cmd)) {
      if (!publicMenu().accepting_orders) return publicMenu().closed_message;
      const o = await ownedOrder(st, cmd.split(' ')[1]);
      if (!o) return 'I cannot find that order in this chat.';
      const lines = JSON.parse(o.items_json).map(l => {
        const opts = {};
        for (const option of l.options || []) (opts[option.group] ||= []).push(option.choice);
        return { item_id: l.item_id, qty: l.qty, options: opts, note: l.note || '' };
      });
      try { priceCart(lines); } catch { return 'Some items or choices from that order are no longer available. Send MENU to build a new basket.'; }
      st.cart = lines; delete st.pendingToken;
      return 'Your previous items are back in the basket at today’s prices. Nothing has been ordered yet.\n\n' + basket(st);
    }
    if (/^CANCEL ORDER(?: GF-\d+)?$/.test(cmd)) {
      const o = await ownedOrder(st, cmd.split(' ')[2]);
      if (!o) return 'I cannot find that order in this chat.';
      if (require('./sunpay').ACTIVE.includes(o.payment_status)) return 'This order has a pending or completed payment. Contact the kitchen to resolve payment before cancelling; payments are not automatically refunded.';
      if (o.status !== 'new') return o.status === 'cancelled' ? `Order ${o.code} is already cancelled.` : 'That order is already being handled. Please contact the team to request a change.';
      st.cancelToken = o.track_token;
      st.suggestions = buttons(['Confirm cancellation', 'CONFIRM CANCELLATION'], ['Keep order', 'KEEP ORDER']);
      return `Cancel order ${o.code} (${money(o.total)})? Reply CONFIRM CANCELLATION to cancel it, or KEEP ORDER. You can also use the buttons below.`;
    }
    if (cmd === 'KEEP ORDER') { delete st.cancelToken; st.suggestions = standard(); return 'Your order has not been cancelled.'; }
    if (cmd === 'CONFIRM CANCELLATION') {
      if (!st.cancelToken || !tokens(st).includes(st.cancelToken)) return 'Choose an order to cancel first.';
      const row = await db.transaction(async tx => {
        const o = await tx.one('SELECT * FROM orders WHERE track_token=$1 FOR UPDATE', [st.cancelToken]);
        if (!o || require('./sunpay').ACTIVE.includes(o.payment_status)) return null;
        return tx.one("UPDATE orders SET status='cancelled',updated_at=now() WHERE track_token=$1 AND status='new' RETURNING *", [st.cancelToken]);
      });
      delete st.cancelToken; st.suggestions = standard();
      if (!row) return 'The order status changed. Send STATUS to check it or contact the team.';
      if (notifyCancelled) await notifyCancelled(row);
      return `Order ${row.code} has been cancelled.`;
    }
    if (cmd === 'CANCEL' || cmd === 'START OVER') {
      st.cart = []; delete st.draft; delete st.details; delete st.pendingToken;
      return 'Your basket has been cleared. Previously placed orders are unchanged.\n\n' + menu(st);
    }
    if (cmd === 'HELP' || cmd === 'AGENT') {
      st.suggestions = standard();
      if (cmd === 'AGENT') {
        const phone = st.senderPhone || st.details?.phone;
        if (!phone) { st.resumeStep = st.step; st.step = 'support_phone'; return 'What Kenyan phone number should the team use to contact you?'; }
        const sent = await requestAgent(phone, st.details?.customer_name || '');
        return sent ? 'The team has been notified of your callback request. You can keep ordering here while you wait.' : 'I could not notify the team automatically. Please use the contact number on your order tracking page or the connected WhatsApp option.';
      }
      return `I'm the ${publicMenu().business_name} automated ordering assistant. Send MENU to order, BASKET to review your basket, STATUS to track an order from this chat, or CANCEL to start over.${whatsappUrl() ? '\nFor WhatsApp, use Back and choose Open WhatsApp.' : '\nWhatsApp is not connected right now.'}`;
    }
    if (cmd === 'MENU' || /^(HI|HELLO|HEY)$/.test(cmd)) return menu(st);
    if (!publicMenu().accepting_orders) { st.suggestions = standard(); return publicMenu().closed_message || 'We are not taking orders right now.'; }
    if (cmd === 'BASKET') return basket(st);
    if (/^REMOVE \d+$/.test(cmd)) {
      const n = Number(cmd.split(' ')[1]) - 1;
      if (n < 0 || n >= st.cart.length) return 'That basket line does not exist.\n\n' + basket(st);
      st.cart.splice(n, 1); return basket(st);
    }
    if (cmd === 'CHECKOUT') {
      if (!st.cart.length) return basket(st);
      priceCart(st.cart);
      st.details ||= {};
      return nextDetails(st);
    }
    switch (st.step) {
      case 'support_phone': {
        const phone = normPhone(text);
        if (!validPhone(phone)) return 'Please enter a valid Kenyan phone number.';
        st.step = st.resumeStep || 'menu'; delete st.resumeStep; st.suggestions = standard();
        const sent = await requestAgent(phone, st.details?.customer_name || '');
        return sent ? 'The team has been notified of your callback request.' : 'I could not notify the team automatically. Please use the contact number on your order tracking page or the connected WhatsApp option.';
      }
      case 'menu': {
        const items = publicMenu().items;
        const item = /^\d+$/.test(text) ? items.find(i => i.id === st.menuIds?.[Number(text) - 1]) : items.find(i => i.name.toLowerCase() === text.toLowerCase());
        if (!item) return 'Please choose one of the dishes below.\n\n' + menu(st);
        st.draft = { item_id: item.id, options: {} }; st.group = 0;
        return options(st);
      }
      case 'options': {
        const item = publicMenu().items.find(i => i.id === st.draft.item_id);
        if (!item) return menu(st);
        const group = item.options[st.group];
        if (!group) return options(st);
        if (text === '0' && !group.required) st.draft.options[group.name] = [];
        else {
          const labels = text.split(',').map(v => v.trim()).filter(Boolean).map(v => {
            const c = /^\d+$/.test(v) ? group.choices[Number(v) - 1] : group.choices.find(c => c.label.toLowerCase() === v.toLowerCase());
            return c?.label;
          });
          if (!labels.length || labels.some(v => !v) || (group.type !== 'multi' && labels.length !== 1)) return 'Please choose a valid option.\n\n' + options(st);
          st.draft.options[group.name] = [...new Set(labels)];
        }
        st.group++; return options(st);
      }
      case 'quantity': {
        const item = publicMenu().items.find(i => i.id === st.draft.item_id);
        if (!item) return menu(st);
        const qty = Number(text);
        if (!/^\d+$/.test(text) || qty < item.min_qty || qty > 50) return `Please enter a whole number from ${item.min_qty} to 50.`;
        const line = { ...st.draft, qty };
        priceCart([line]);
        if (st.cart.length >= 30) return 'Your basket is full.\n\n' + basket(st);
        st.cart.push(line); delete st.draft;
        return 'Added to your basket.\n\n' + basket(st);
      }
      case 'basket': return basket(st);
      case 'name':
        if (text.length < 2 || text.length > 80) return 'Please enter a name between 2 and 80 characters.';
        st.details.customer_name = text; return nextDetails(st);
      case 'phone': {
        const phone = normPhone(text);
        if (!validPhone(phone)) return 'Please enter a valid Kenyan phone number, for example 0712 345 678.';
        st.details.phone = st.senderPhone || phone; return nextDetails(st);
      }
      case 'address':
        if (text.length < 3 || text.length > 300) return 'Please enter a delivery address between 3 and 300 characters.';
        st.details.location = text; return nextDetails(st);
      case 'time':
        if (text.length < 2 || text.length > 60) return 'Please enter a delivery time between 2 and 60 characters.';
        st.details.delivery_time = text; st.details.delivery_date = ''; return nextDetails(st);
      case 'notes':
        if (text.length > 500) return 'Please keep delivery notes under 500 characters.';
        st.details.notes = /^(0|none|no)$/i.test(text) ? '' : text;
        return confirm(st);
      case 'confirm': {
        if (cmd !== 'CONFIRM') return confirm(st);
        // Persist a unique order token BEFORE insertion so retries after a lost
        // response or process restart recover the same order rather than duplicate it.
        let existing = st.pendingToken ? await db.one('SELECT * FROM orders WHERE track_token=$1', [st.pendingToken]) : null;
        if (!existing && priceCart(st.cart).total !== st.quotedTotal) return 'The price has changed. Please check the updated total and confirm again.\n\n' + confirm(st);
        if (!existing && rateLimited(req.ip)) return 'Too many orders from this device. Please wait ten minutes before confirming.';
        if (!st.pendingToken) { st.pendingToken = crypto.randomBytes(16).toString('base64url'); await save(key, st); }
        const order = existing ? rowToOrder(existing) : await createOrder({ ...st.details, items: st.cart }, req.channel === 'whatsapp' ? 'whatsapp' : 'website', st.pendingToken);
        st.lastToken = st.pendingToken; st.orderTokens = tokens(st); delete st.pendingToken; st.cart = []; st.step = 'menu'; delete st.details;
        st.suggestions = standard();
        if ((await db.one('SELECT enabled FROM sunpay_config WHERE id=1'))?.enabled && require('./credentials').status('sunpay').configured) st.suggestions.unshift({ label: 'Pay with M-Pesa', value: `PAY ${order.code}` });
        return `Order ${order.code} confirmed!\nTotal: ${money(order.total)}\nDelivery: ${order.location}\n\n${publicMenu().payment_note || ''}\nTrack your order: /t/${st.lastToken}\n\nThank you for ordering with ${publicMenu().business_name}.`;
      }
      default: return menu(st);
    }
  }
  app.get('/api/chat', guard, wrap(async (req, res) => {
    const key = session(req, res, true);
    if (busy.has(key)) return res.status(409).json({ error: 'Your message is being processed. Please try again shortly.' });
    busy.add(key);
    try {
      const st = await load(key);
      if (!st.messages.length) {
        add(st, 'assistant', `Welcome to ${publicMenu().business_name}! I'm your ordering assistant. You can order right here without leaving this page.\n\n` + menu(st));
        await save(key, st);
      }
      res.json(result(st));
    } finally { busy.delete(key); }
  }));
  app.post('/api/chat/messages', guard, wrap(async (req, res) => {
    const key = session(req, res, false);
    if (!key) return res.status(401).json({ error: 'Your chat session expired. Close and reopen the chat.' });
    const { message, request_id } = req.body || {};
    if (typeof message !== 'string' || !message.trim() || message.length > 1000 || typeof request_id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request_id)) return res.status(400).json({ error: 'Please send a message of 1–1000 characters with a valid request ID.' });
    if (busy.has(key)) return res.status(409).json({ error: 'Please wait for the previous reply, then retry.' });
    busy.add(key);
    try {
      const st = await load(key);
      if (st.requests.includes(request_id)) return res.json(result(st));
      const reply = await smartAnswer(st, message.trim(), key, req);
      add(st, 'user', message.trim()); add(st, 'assistant', reply);
      st.requests.push(request_id); st.requests = st.requests.slice(-100);
      await save(key, st);
      res.json(result(st));
    } finally { busy.delete(key); }
  }));
  // Structured hand-off from the storefront item sheet. Deterministic; never places an order.
  const { transfer } = require('./chat-transfer');
  app.post('/api/chat/cart', guard, wrap(async (req, res) => {
    const key = session(req, res, true);
    if (busy.has(key)) return res.status(409).json({ error: 'Your chat is busy. Please retry in a moment.' });
    busy.add(key);
    try {
      const st = await load(key);
      const out = transfer(st, req.body, { menu: publicMenu(), priceCart, basket, money });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      if (out.changed) {
        if (!st.messages.length) add(st, 'assistant', `Welcome to ${publicMenu().business_name}! I'm your ordering assistant.`);
        add(st, 'user', out.userText); add(st, 'assistant', out.reply);
        await save(key, st);
      }
      res.json({ ...result(st), ...out.body });
    } finally { busy.delete(key); }
  }));
  const uploadVoice = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2000000, files: 1, fields: 0 } }).single('audio');
  app.post('/api/chat/transcribe', guard, (req, res, next) => {
    if (!session(req, res, false)) return res.status(401).json({ error: 'Open the chat before recording a voice note.' });
    uploadVoice(req, res, err => err ? res.status(400).json({ error: 'Please send one voice note under 2 MB and 60 seconds.' }) : next());
  }, async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Please record or upload a voice note.' });
      res.json({ text: await ai.transcribe(req.file.buffer, req.ip) });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  return {
    async handleWhatsApp(phone, input, requestId) {
      const key = `wa:${phone}`;
      if (busy.has(key)) return 'Please wait for the previous reply before sending another message.';
      busy.add(key);
      try {
        const st = await load(key);
        st.senderPhone = phone;
        const owned = await db.q('SELECT track_token FROM orders WHERE phone=$1 ORDER BY id DESC LIMIT 10', [phone]);
        st.orderTokens = owned.map(o => o.track_token).reverse();
        st.lastToken = owned[0]?.track_token;
        if (requestId && st.requests.includes(requestId)) return st.messages.at(-1)?.text || 'Send MENU to continue.';
        let text = String(input.text || '').trim().slice(0, 1000);
        if (input.location) text = `My delivery address is ${input.location.name || ''} ${input.location.address || ''} (map coordinates ${input.location.latitude}, ${input.location.longitude})`;
        if (!text) return 'Please send a text message. Voice notes are supported in the website chat.';
        const reply = await smartAnswer(st, text, key, { ip: `wa:${phone}`, channel: 'whatsapp' });
        add(st, 'user', text); add(st, 'assistant', reply);
        if (requestId) st.requests = [...st.requests, requestId].slice(-100);
        await save(key, st);
        return reply;
      } finally { busy.delete(key); }
    }
  };
};
