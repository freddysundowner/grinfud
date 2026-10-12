// Deterministic menu -> website-chat cart transfer. No AI involved.
// The browser sends item ids, quantities, option labels and notes only; any price it sends is ignored.
// Prices are recomputed by priceCart. Nothing is ordered here: the customer still reviews,
// gives details and confirms inside the chat.
const REQ_RE = /^[a-zA-Z0-9-]{16,80}$/;

function fail(status, error) { return { status, body: { error } }; }

function validLine(raw, items) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each order line must be an object.');
  const item = items.find(i => i.id === raw.item_id);
  if (!Number.isInteger(raw.item_id) || !item) throw new Error('One of the items is no longer on the menu.');
  if (!Number.isInteger(raw.qty) || raw.qty < item.min_qty || raw.qty > 50) throw new Error(`${item.name} needs a quantity from ${item.min_qty} to 50.`);
  const opts = raw.options == null ? {} : raw.options;
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new Error(`Please choose options for ${item.name} from the menu.`);
  const out = {};
  for (const [group, sel] of Object.entries(opts)) {
    const g = item.options.find(x => x.name === group);
    if (!g) throw new Error(`"${group}" is not an option for ${item.name}.`);
    if (!Array.isArray(sel) || sel.some(v => typeof v !== 'string')) throw new Error(`Please choose a listed option for ${g.name}.`);
    const uniq = [...new Set(sel)];
    if (g.type !== 'multi' && uniq.length > 1) throw new Error(`Choose only one option for ${g.name}.`);
    if (uniq.some(l => !g.choices.some(c => c.label === l))) throw new Error(`Please choose a listed option for ${g.name}.`);
    if (uniq.length) out[g.name] = uniq;
  }
  const missing = item.options.find(g => g.required && !(out[g.name] || []).length);
  if (missing) throw new Error(`Please choose ${missing.name} for ${item.name}.`);
  if (raw.note != null && typeof raw.note !== 'string') throw new Error('Notes must be text.');
  const note = String(raw.note || '').trim();
  if (note.length > 200) throw new Error('Please keep each special request under 200 characters.');
  return { item_id: item.id, qty: raw.qty, options: out, note };
}

// Returns { status, body, changed }. Mutates st only on success.
function transfer(st, body, { menu, priceCart, basket, money }) {
  if (!menu.website_chat_enabled) return fail(403, 'Website chat is currently turned off.');
  const { request_id, lines } = body || {};
  if (typeof request_id !== 'string' || !REQ_RE.test(request_id)) return fail(400, 'A valid request ID is required.');
  st.requests = Array.isArray(st.requests) ? st.requests : [];
  st.cart = Array.isArray(st.cart) ? st.cart : [];
  if (st.requests.includes(request_id)) return { status: 200, body: { duplicate: true }, changed: false };
  if (!menu.accepting_orders) return fail(409, menu.closed_message || 'We are not taking orders right now.');
  if (!Array.isArray(lines) || !lines.length || lines.length > 30) return fail(400, 'Send between 1 and 30 order lines.');
  if (st.cart.length + lines.length > 30) return fail(400, 'Your chat order is full (30 lines). Remove something in the chat first.');
  let clean, priced;
  try {
    clean = lines.map(l => validLine(l, menu.items));
    priced = priceCart(clean);
    priceCart([...st.cart, ...clean]);
  } catch (e) { return fail(400, e.message || 'Those items could not be added.'); }
  const describe = priced.lines.map(l => `${l.qty} × ${l.name}${l.options.length ? ' (' + l.options.map(o => o.choice).join(', ') + ')' : ''}${l.note ? ' — note: ' + l.note : ''}`).join('\n');
  st.cart.push(...clean);
  delete st.pendingToken; delete st.draft;
  st.requests.push(request_id); st.requests = st.requests.slice(-100);
  const userText = `Add from the menu:\n${describe}`;
  const reply = `Added ${priced.lines.length === 1 ? 'that' : 'those items'} to your order at today's prices (${money(priced.subtotal)}). Nothing has been ordered yet.\n\n` + basket(st);
  return { status: 200, body: { added: priced.lines.length }, changed: true, userText, reply };
}

module.exports = { transfer, validLine, REQ_RE };
