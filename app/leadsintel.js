// LeadsIntel External-Platform WhatsApp API client (https://leadsintel.net/developers.html)
//
// Only the platform key lives in the environment. The WhatsApp number itself is chosen in
// Admin → Settings → WhatsApp number (connect a new number, or use one already on LeadsIntel),
// and its tenant/connection ids + webhook secret are kept in the database (wa_link table).
//
//   LEADSINTEL_PLATFORM_KEY  li_platform_...   (server-side only, never in the browser)
//   LEADSINTEL_TENANT_ID     optional: tenant id used for NEW numbers (default "grinfud")
//   LEADSINTEL_API_BASE      default https://app.leadsintel.net/api
const crypto = require('crypto');

let store = { get: () => ({}), set: () => {} };
const init = s => { store = s; };

const base = () => (process.env.LEADSINTEL_API_BASE || 'https://app.leadsintel.net/api').replace(/\/$/, '');
const key = () => {
  const configured = require('./credentials').get('leadsintel');
  return configured && process.argv.includes('--demo') ? process.env.LEADSINTEL_PLATFORM_KEY : configured;
};
// A new number only becomes usable for sending once its assisted setup reports "connected".
const cfg = () => { const l = store.get() || {}; const usable = l.mode === 'existing' || (l.mode === 'new' && l.request_status === 'connected');
  return { key: key(), tenant: usable ? l.tenant_id || '' : '', conn: usable ? l.connection_id || '' : '',
  secret: l.webhook_secret || '', phoneNumberId: l.phone_number_id || '' }; };
const keyConfigured = () => !!key();
const sendConfigured = () => { const c = cfg(); return !!(c.key && c.tenant && c.conn); };
const inboundConfigured = () => !!cfg().secret;
const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('hex');

async function call(method, path, body, extraHeaders = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(base() + path, {
      method, signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: r.ok, status: r.status, data, retryAfter: r.headers.get('retry-after') };
  } catch (e) { return { ok: false, status: 0, data: { error: e.name === 'AbortError' ? 'timeout' : e.message } }; }
  finally { clearTimeout(t); }
}
const errText = r => { const e = r.data && (r.data.error || r.data.message) || r.data || 'unknown error';
  return `LeadsIntel ${r.status || 'network'}: ${typeof e === 'string' ? e : JSON.stringify(e)}`.slice(0, 300); };
const enc = encodeURIComponent;
const connPath = (tenant, conn) => { const c = cfg(); return `/external-platform/whatsapp/connections/${enc(tenant || c.tenant)}/${enc(conn || c.conn)}`; };

// ---- sending ----
// `idemKey` must be stable for the same recipient + content so a retry never double-sends.
async function send(to, message, idemKey) {
  if (!sendConfigured()) return { ok: false, error: 'No WhatsApp number is connected yet.' };
  const body = typeof message === 'string' ? { to, type: 'text', text: message.slice(0, 4000) } : { to, ...message };
  const k = (idemKey || crypto.createHash('sha256').update(to + JSON.stringify(body)).digest('hex')).slice(0, 200);
  let r = await call('POST', connPath() + '/send', body, { 'Idempotency-Key': k });
  if (r.status === 502 || r.status === 0) r = await call('POST', connPath() + '/send', body, { 'Idempotency-Key': k }); // docs: retry 502 with same key
  return r.ok ? { ok: true, messageId: r.data && r.data.messageId } : { ok: false, error: errText(r) };
}

// ---- connections ----
const getConnection = (tenant, conn) => call('GET', connPath(tenant, conn));
const patchConnection = (tenant, conn, body) => call('PATCH', connPath(tenant, conn), body); // 204 on success
const lookup = phoneE164 => call('POST', '/external-platform/whatsapp/connections/lookup', { phoneNumber: phoneE164 });
const lookupClaim = phoneNumber => call('POST', '/external-platform/whatsapp/existing-numbers/lookup', { phoneNumber });
const createClaim = body => call('POST', '/external-platform/whatsapp/existing-numbers/claims', body);
const verifyClaim = (id, code) => call('POST', `/external-platform/whatsapp/existing-numbers/claims/${enc(id)}/verify`, { code });

// ---- assisted setup (connect a new number) ----
const createAssisted = body => call('POST', '/external-platform/whatsapp/assisted-requests', body);
const getAssisted = id => call('GET', `/external-platform/whatsapp/assisted-requests/${enc(id)}`);
const cancelAssisted = id => call('DELETE', `/external-platform/whatsapp/assisted-requests/${enc(id)}`);

// Verify X-LeadIntel-Signature = hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`), timestamp within 5 minutes.
function verify(rawBody, headers) {
  const c = cfg(); if (!c.secret) return { ok: false, reason: 'no WhatsApp number connected' };
  const ts = String(headers['x-leadintel-timestamp'] || ''); const sig = String(headers['x-leadintel-signature'] || '').toLowerCase();
  if (!/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'missing signature' };
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return { ok: false, reason: 'stale timestamp' };
  const expected = crypto.createHmac('sha256', c.secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad signature' };
}

module.exports = { init, cfg, send, verify, errText, newSecret, getConnection, patchConnection, lookup, lookupClaim, createClaim, verifyClaim,
  createAssisted, getAssisted, cancelAssisted, keyConfigured, sendConfigured, inboundConfigured };
