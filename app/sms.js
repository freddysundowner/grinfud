// Order alerts by SMS through Blessed Texts (https://sms.blessedtexts.com).
// The API key, sender ID and receiving number(s) are typed in by the admin (Admin → Settings → SMS alerts)
// and stored in the settings table; the key is never sent back to the browser.
const API_URL = () => process.env.BLESSEDTEXTS_API_URL || 'https://sms.blessedtexts.com/api/sms/v1/sendsms';

const configured = s => !!(s.sms_api_key && s.sms_sender_id);
const enabled = s => s.sms_enabled === '1' && configured(s);
// One or more numbers, comma separated. Empty means "the kitchen phone".
const recipients = s => String(s.sms_phone || s.notify_phone || '').split(/[,\s]+/).map(p => p.replace(/\D/g, '')).filter(Boolean);

// Plain GSM characters keep an SMS at 160 characters a part (one emoji or "–" would cut that to 70).
const plain = t => String(t).replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/×/g, 'x').replace(/[^\x20-\x7E\n]/g, '').replace(/[ \t]+/g, ' ').trim();

function orderText(o, s) {
  const items = o.items.map(i => `${i.qty}x ${i.name}${(i.options || []).length ? ` (${i.options.map(op => op.choice).join(', ')})` : ''}`).join(', ');
  return plain([`New ${s.business_name} order ${o.code}`, `${o.customer_name} 0${String(o.phone).slice(3)}`, items, `Total ${s.currency} ${o.total}`,
    o.location, o.map_link ? `Map: ${o.map_link}` : '', [o.delivery_date, o.delivery_time].filter(Boolean).join(', '), o.notes ? `Note: ${o.notes}` : ''].filter(Boolean).join('\n')).slice(0, 459);
}

async function send(s, message, phones = recipients(s)) {
  if (!configured(s)) return { ok: false, error: 'Add the Blessed Texts API key and sender ID in Settings first.' };
  if (!phones.length) return { ok: false, error: 'No phone number is set to receive the SMS.' };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(API_URL(), { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ api_key: s.sms_api_key, sender_id: s.sms_sender_id, message: plain(message), phone: phones.join(',') }) });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
    // Success is a list with one entry per phone, each with status_code "1000".
    const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
    const bad = list.find(x => String(x.status_code) !== '1000');
    if (r.ok && list.length && !bad) return { ok: true, cost: list.reduce((n, x) => n + (Number(x.message_cost) || 0), 0) };
    const why = bad ? [bad.status_desc || bad.message || bad.error, bad.status_code && `code ${bad.status_code}`].filter(Boolean).join(', ') : `HTTP ${r.status}`;
    return { ok: false, error: `Blessed Texts: ${why || 'unexpected reply'}`.slice(0, 200) };
  } catch (e) { return { ok: false, error: `Blessed Texts: ${e.name === 'AbortError' ? 'no answer (timeout)' : e.message}`.slice(0, 200) }; }
  finally { clearTimeout(t); }
}

module.exports = { send, enabled, configured, recipients, orderText, plain };
