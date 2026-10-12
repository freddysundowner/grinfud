// AI proposes a narrow action. This module validates it against the live menu;
// order placement, payment and cancellation are NOT model-executable actions.
module.exports = function createActions({ publicMenu, priceCart, normPhone, validPhone, basket, options, nextDetails }) {
  function choices(item, values = []) {
    if (!Array.isArray(values) || values.length > 30) throw new Error('Please choose options from the menu.');
    const out = Object.create(null);
    for (const entry of values) {
      const g = item.options.find(g => g.name === entry.group);
      if (!g || !Array.isArray(entry.choices) || entry.choices.length > g.choices.length) throw new Error('That option is not on the current menu.');
      const selected = [...new Set(entry.choices)];
      if (g.type !== 'multi' && selected.length > 1) throw new Error(`Choose only one option for ${g.name}.`);
      if (selected.some(label => !g.choices.some(c => c.label === label))) throw new Error(`Please choose a listed option for ${g.name}.`);
      out[g.name] = selected;
    }
    return out;
  }
  function line(raw) {
    const item = publicMenu().items.find(i => i.id === raw.item_id);
    if (!item) throw new Error('That item is not currently on the menu.');
    if (!Number.isInteger(raw.qty) || raw.qty < item.min_qty || raw.qty > 50) throw new Error(`${item.name} needs a quantity from ${item.min_qty} to 50.`);
    const options = choices(item, raw.options);
    const missing = item.options.findIndex(g => g.required && !options[g.name]?.length);
    const value = { item_id: item.id, qty: raw.qty, options, note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '' };
    if (missing < 0) priceCart([value]);
    return { item, value, missing };
  }
  function run(st, plan) {
    switch (plan.action) {
      case 'add': {
        if (!publicMenu().accepting_orders) return { reply: publicMenu().closed_message };
        if (!Array.isArray(plan.items) || !plan.items.length || plan.items.length + st.cart.length > 30) throw new Error('Please add between 1 and 30 basket lines.');
        const lines = plan.items.map(line), incomplete = lines.filter(l => l.missing >= 0);
        if (incomplete.length && lines.length > 1) return { reply: 'Some required choices are missing. Please add those dishes one at a time so I can ask for each choice.' };
        if (incomplete.length) {
          st.draft = lines[0].value; st.group = lines[0].missing;
          return { reply: options(st) };
        }
        st.cart.push(...lines.map(l => l.value)); delete st.pendingToken;
        return { reply: 'Added to your basket.\n\n' + basket(st) };
      }
      case 'update': {
        if (!publicMenu().accepting_orders) return { reply: publicMenu().closed_message };
        if (plan.options !== undefined && !Array.isArray(plan.options)) throw new Error('Please choose options from the menu.');
        const index = Number(plan.line) - 1, old = st.cart[index];
        if (!Number.isInteger(index) || !old) throw new Error('Please choose a basket line to change.');
        const oldOptions = Object.entries(old.options || {}).map(([group, choices]) => ({ group, choices }));
        const merged = [...oldOptions.filter(o => !(plan.options || []).some(n => n.group === o.group)), ...(plan.options || [])];
        const updated = line({ ...old, qty: plan.qty ?? old.qty, options: merged });
        if (updated.missing >= 0) throw new Error(`Please choose ${updated.item.options[updated.missing].name}.`);
        st.cart[index] = updated.value; delete st.pendingToken;
        return { reply: 'Basket updated.\n\n' + basket(st) };
      }
      case 'remove':
        if (!Number.isInteger(plan.line) || plan.line < 1 || plan.line > st.cart.length) throw new Error('Please choose a basket line to remove.');
        st.cart.splice(plan.line - 1, 1); delete st.pendingToken;
        return { reply: basket(st) };
      case 'details': {
        if (!st.cart.length) return { reply: 'Choose your food first, then I’ll take your delivery details.' };
        if (!plan.details || typeof plan.details !== 'object') throw new Error('Please provide your delivery details.');
        const next = { ...(st.details || {}) };
        const limits = { customer_name: [2, 80], location: [3, 300], delivery_time: [2, 60], notes: [0, 500] };
        for (const [key, [min, max]] of Object.entries(limits)) {
          if (!(key in plan.details)) continue;
          const val = plan.details[key];
          if (typeof val !== 'string' || val.trim().length < min || val.length > max) throw new Error(`Please check your ${key.replaceAll('_', ' ')}.`);
          next[key] = val.trim();
        }
        if ('phone' in plan.details) {
          if (typeof plan.details.phone !== 'string') throw new Error('Please enter a valid Kenyan phone number.');
          const phone = normPhone(plan.details.phone);
          if (!validPhone(phone)) throw new Error('Please enter a valid Kenyan phone number, e.g. 0712 345 678.');
          next.phone = phone;
        }
        if (st.senderPhone) next.phone = st.senderPhone;
        st.details = next;
        return { reply: nextDetails(st) };
      }
      case 'command': {
        const allowed = ['MENU', 'BASKET', 'CHECKOUT', 'STATUS', 'ORDERS', 'REORDER', 'CANCEL ORDER', 'AGENT', 'CANCEL'];
        if (!allowed.includes(plan.command)) throw new Error('Please use the menu buttons for that action.');
        if (plan.order_code && ['STATUS', 'REORDER', 'CANCEL ORDER'].includes(plan.command)) {
          if (!/^GF-\d+$/.test(plan.order_code)) throw new Error('Please check that order number.');
          return { command: `${plan.command} ${plan.order_code}` };
        }
        return { command: plan.command };
      }
      case 'choose':
        if (!['menu', 'options', 'quantity'].includes(st.step) || typeof plan.value !== 'string' || plan.value.length > 100) return { reply: 'Please use the displayed confirmation button, or tell me what you want to change.' };
        if (/^(CONFIRM|CANCEL|CHECKOUT|STATUS|MENU|AGENT)/i.test(plan.value)) throw new Error('Please choose an option from the current question.');
        return { command: plan.value };
      case 'reply':
        if (typeof plan.reply !== 'string' || !plan.reply.trim()) throw new Error('Could you rephrase that request?');
        return { reply: plan.reply.slice(0, 1600).replace(/https?:\/\/\S+|\/t\/[\w-]+/g, '[link omitted]') };
      default: throw new Error('Could you rephrase that request?');
    }
  }
  return { run };
};
