// Order alerts over WhatsApp, sent through LeadsIntel (see leadsintel.js for the connection settings).
//
// WhatsApp only allows free text to numbers that messaged your business number in the last 24 hours.
// To be sure alerts always arrive, create approved templates in LeadsIntel and set:
//   KITCHEN_TEMPLATE_NAME   template with ONE body variable {{1}}, e.g.
//                           "New GrinFud order: {{1}}. Check WhatsApp or admin for details."
//   CUSTOMER_TEMPLATE_NAME  (optional) template with ONE body variable {{1}} for website customers, e.g.
//                           "Thank you for ordering from GrinFud! {{1}}"
//   TEMPLATE_LANGUAGE       default "en"
// Without templates, plain text is sent (works inside the 24-hour window).
const li = require('./leadsintel');

function money(n, s) { return `${s.currency || 'KSh'} ${Number(n || 0).toLocaleString('en-KE')}`; }

function kitchenMessage(o, s) {
  const L = [`🧺 NEW ORDER ${o.code}  (${o.source === 'whatsapp' ? 'WhatsApp' : 'Website'})`, '',
    `👤 ${o.customer_name}`, `📞 ${o.phone}`, `📍 ${o.location}`];
  if (o.map_link) L.push(`🗺 Pin: ${o.map_link}`);
  if (o.delivery_date || o.delivery_time) L.push(`🕖 ${[o.delivery_date, o.delivery_time].filter(Boolean).join(', ')}`);
  L.push('');
  for (const it of o.items) {
    L.push(`${it.qty} × ${it.name} — ${money(it.line_total, s)}`);
    for (const op of it.options || []) L.push(`   • ${op.group}: ${op.choice}${op.price ? ` (+${money(op.price, s)})` : ''}`);
    if (it.note) L.push(`   ✎ ${it.note}`);
  }
  L.push('');
  if (o.delivery_fee) L.push(`Delivery: ${money(o.delivery_fee, s)}`);
  L.push(`TOTAL: ${money(o.total, s)}`);
  if (o.notes) L.push('', `Notes: ${o.notes}`);
  if (require('./public-urls').origin()) L.push('', `Manage: ${require('./public-urls').absolute('/admin')}`);
  return L.join('\n');
}
const oneLine = (o, s) => `${o.code} · ${o.customer_name} · ${o.items.map(i => `${i.qty}× ${i.name}`).join(', ')} · ${money(o.total, s)}`.replace(/\s+/g, ' ').slice(0, 900);

function customerMessage(o, s) {
  return [`Hi ${o.customer_name}, thank you for ordering from ${s.business_name}! 🧺`,
    `Your order ${o.code} is received. Total: ${money(o.total, s)}.`,
    `Delivery to: ${o.location}${o.delivery_date ? `, ${o.delivery_date}` : ''}${o.delivery_time ? `, ${o.delivery_time}` : ''}.`,
    s.payment_note || '', /^https?:/.test(o.track_url || '') ? `Track your order: ${o.track_url}` : ''].filter(Boolean).join('\n');
}
const template = (name, param) => ({ type: 'template', name, language: process.env.TEMPLATE_LANGUAGE || 'en',
  components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }] });

// The kitchen can be several phones (comma separated in Settings). The first one is the number customers are told to call.
const kitchenPhones = s => String(s.notify_phone || '').split(',').map(p => p.replace(/\D/g, '')).filter(Boolean);
const kitchenPhone = s => kitchenPhones(s)[0] || '';
// Send one alert to every kitchen phone. It counts as delivered if at least one phone got it; `error` lists the ones that did not.
async function sendKitchen(s, message, idem) {
  const phones = kitchenPhones(s); if (!phones.length) return { ok: false, error: 'No kitchen phone is set (Admin → Settings).' };
  const results = await Promise.all(phones.map((p, i) => (typeof message === 'string' ? sendText : li.send)(p, message, i ? `${idem}-${p}` : idem).catch(e => ({ ok: false, error: e.message }))));
  const failed = results.map((r, i) => (r.ok ? '' : `+${phones[i]}: ${r.error}`)).filter(Boolean);
  return { ok: results.some(r => r.ok), error: failed.join(' / ') };
}

async function sendText(to, message, idem) {
  if (!li.sendConfigured()) { console.log(`[notify:not-configured] to ${to}\n${message}\n`); return { ok: false, error: 'No WhatsApp number is connected yet (Admin → Settings). Use the WhatsApp button for now.' }; }
  return li.send(to, message, idem);
}

async function sendOrderNotifications(order, s, { kitchenOnly = false, attempt = 0 } = {}) {
  const tag = attempt ? `-r${attempt}` : '';
  let tpl = { ok: false };
  if (process.env.KITCHEN_TEMPLATE_NAME && li.sendConfigured())
    tpl = await sendKitchen(s, template(process.env.KITCHEN_TEMPLATE_NAME, oneLine(order, s)), `order-${order.code}-kitchen-tpl${tag}`);
  const txt = await sendKitchen(s, kitchenMessage(order, s), `order-${order.code}-kitchen${tag}`);
  if (!kitchenOnly && order.source === 'web' && s.notify_customer === '1' && li.sendConfigured()) {
    if (process.env.CUSTOMER_TEMPLATE_NAME) await li.send(order.phone, template(process.env.CUSTOMER_TEMPLATE_NAME, `Order ${order.code}, total ${money(order.total, s)}. We'll deliver to ${order.location}.`), `order-${order.code}-customer-tpl`);
    else await li.send(order.phone, customerMessage(order, s), `order-${order.code}-customer`);
  }
  if (tpl.ok || txt.ok) return { ok: true, error: txt.ok ? txt.error : '' };
  return { ok: false, error: [tpl.error, txt.error].filter(Boolean).join(' / ') };
}

const kitchenWaLink = (o, s) => `https://wa.me/${kitchenPhone(s)}?text=${encodeURIComponent(kitchenMessage(o, s))}`;

module.exports = { sendText, sendKitchen, kitchenPhones, kitchenPhone, sendOrderNotifications, kitchenWaLink, kitchenMessage, money };
