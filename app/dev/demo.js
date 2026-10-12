// DEMO MODE ONLY (npm run demo). A fake LeadsIntel that runs inside this app, plus a WhatsApp simulator,
// so the whole flow can be seen on a laptop with no LeadsIntel key and no real WhatsApp number.
// It follows https://leadsintel.net/developers.html: lookup, assisted setup, connections, send, signed inbound webhooks.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function mountDemo(app, { dataDir, key, getSettings }) {
  const file = path.join(dataDir, 'demo-leadsintel.json');
  const blank = () => ({
    // One number is already "on LeadsIntel", so the "Number already on LeadsIntel" option can be tried.
    conns: { 'pevma/wa-main': { externalPlatformTenantId: 'pevma', externalConnectionId: 'wa-main', phoneNumberId: 'pn_demo_1',
      displayPhoneNumber: '+254 711 000 111', e164: '+254711000111', status: 'active', inboundWebhookUrl: 'https://another-bot.example.com/hook', secret: 'x' } },
    reqs: {}, msgs: [], n: 0,
  });
  let st; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = blank(); }
  const save = () => fs.writeFileSync(file, JSON.stringify(st));
  const digits = s => String(s || '').replace(/\D/g, '');
  const connBy = (t, c) => st.conns[`${t}/${c}`];
  const connByPhone = e164 => Object.values(st.conns).find(c => c.e164 === e164);
  const log = (from, to, text, extra = {}) => { st.msgs.push({ id: ++st.n, from: digits(from), to: digits(to), text, at: Date.now(), ...extra }); st.msgs = st.msgs.slice(-400); save(); };

  // ---------------- fake LeadsIntel API ----------------
  const api = express.Router();
  api.use(express.json());
  api.use((req, res, next) => (req.headers.authorization === `Bearer ${key}` ? next() : res.status(401).json({ error: 'invalid_platform_key' })));

  api.post('/external-platform/whatsapp/connections/lookup', (req, res) => {
    const c = connByPhone(req.body.phoneNumber); if (!c) return res.status(404).json({ error: 'connection_not_found' });
    res.json({ externalPlatformTenantId: c.externalPlatformTenantId, externalConnectionId: c.externalConnectionId, phoneNumberId: c.phoneNumberId,
      displayPhoneNumber: c.displayPhoneNumber, status: c.status, disconnectedAt: null, updatedAt: new Date().toISOString() });
  });
  api.post('/external-platform/whatsapp/assisted-requests', (req, res) => {
    const b = req.body; const e164 = `+${b.countryCode}${b.phoneNumber}`;
    if (connByPhone(e164) || Object.values(st.reqs).some(r => r.e164 === e164)) return res.status(409).json({ error: 'phone_number_already_connected' });
    const id = 'req_' + crypto.randomBytes(4).toString('hex');
    st.reqs[id] = { id, e164, body: b, status: 'pending', at: Date.now(), code: String(100000 + crypto.randomInt(900000)) }; save();
    res.status(202).json({ requestId: id, status: 'pending' });
  });
  api.get('/external-platform/whatsapp/assisted-requests/:id', (req, res) => {
    const r = st.reqs[req.params.id]; if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.status === 'pending' && Date.now() - r.at > 5000) { r.status = 'awaiting_code'; save(); } // simulator then shows the code to "enter"
    res.json({ requestId: r.id, status: r.status, externalPlatformTenantId: r.body.externalPlatformTenantId, externalConnectionId: r.body.externalConnectionId,
      displayPhoneNumber: r.status === 'connected' ? r.e164 : null, errorCode: null, errorMessage: null, updatedAt: new Date().toISOString() });
  });
  api.delete('/external-platform/whatsapp/assisted-requests/:id', (req, res) => {
    const r = st.reqs[req.params.id]; if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.status !== 'pending') return res.status(409).json({ error: 'request_not_pending' });
    r.status = 'cancelled'; save(); res.status(204).end();
  });
  api.get('/external-platform/whatsapp/connections/:t/:c', (req, res) => {
    const c = connBy(req.params.t, req.params.c); if (!c) return res.status(404).json({ error: 'connection_not_found' });
    const { secret, e164, ...pub } = c; res.json({ ...pub, inboundWebhookTimeoutMs: 10000, updatedAt: new Date().toISOString() });
  });
  api.patch('/external-platform/whatsapp/connections/:t/:c', (req, res) => {
    const c = connBy(req.params.t, req.params.c); if (!c) return res.status(404).json({ error: 'connection_not_found' });
    if (req.body.inboundWebhookUrl) c.inboundWebhookUrl = req.body.inboundWebhookUrl;
    if (req.body.inboundWebhookSecret) c.secret = req.body.inboundWebhookSecret;
    save(); res.status(204).end();
  });
  api.post('/external-platform/whatsapp/connections/:t/:c/send', (req, res) => {
    const c = connBy(req.params.t, req.params.c); if (!c) return res.status(404).json({ error: 'connection_not_found' });
    const k = req.headers['idempotency-key']; if (!k) return res.status(400).json({ error: 'valid_idempotency_key_required' });
    if (st.msgs.some(m => m.idem === k)) return res.status(202).json({ messageId: 'dup', status: 'accepted' });
    if (digits(req.body.to) === digits(c.e164)) return res.status(400).json({ error: 'cannot_message_own_number' });
    const b = req.body;
    const text = b.type === 'template' ? `[template ${b.name}] ${((b.components || [])[0]?.parameters || []).map(p => p.text).join(' ')}` : b.text || `[${b.type}]`;
    log(c.e164, b.to, text, { idem: k });
    res.status(202).json({ messageId: 'wamid.demo' + st.n, status: 'accepted' });
  });
  app.use('/demo/leadsintel/api', api);

  // ---------------- pretend Blessed Texts SMS gateway ----------------
  // Same request and reply shape as https://sms.blessedtexts.com/api/sms/v1/sendsms. Texts show up in the simulator's kitchen phone.
  app.post('/demo/sms/sendsms', express.json(), (req, res) => {
    const b = req.body || {}; const phones = String(b.phone || '').split(',').map(digits).filter(Boolean);
    if (!b.api_key || !b.sender_id || !b.message || !phones.length) return res.status(400).json([{ status_code: '1001', status_desc: 'Invalid request' }]);
    res.json(phones.map(p => { log('SMS', p, `📩 SMS from ${b.sender_id}:\n${b.message}`, { sms: true }); return { status_code: '1000', status_desc: 'Success', message_id: 'demo' + st.n, phone: p, message_cost: '0.5' }; }));
  });

  // ---------------- WhatsApp simulator ----------------
  const sim = express.Router();
  sim.use(express.json());
  const publicUrls = require('../public-urls');
  const localCallback = value => {
    try { const u = new URL(value); return u.pathname === '/webhooks/leadsintel' && (u.origin === publicUrls.origin() || ['localhost', '127.0.0.1'].includes(u.hostname)); }
    catch { return false; }
  };
  const activeNumbers = () => Object.values(st.conns).filter(c => c.status === 'active').map(c => ({
    e164: c.e164, display: c.displayPhoneNumber, local: localCallback(c.inboundWebhookUrl),
    webhook: localCallback(c.inboundWebhookUrl) ? publicUrls.absolute('/webhooks/leadsintel') : c.inboundWebhookUrl
  }));

  sim.get('/state', (req, res) => {
    const s = getSettings();
    res.json({ numbers: activeNumbers(), kitchen: String(s.notify_phone).split(',')[0], kitchens: String(s.notify_phone).split(','), msgs: st.msgs.filter(m => m.id > Number(req.query.after || 0)),
      codes: Object.values(st.reqs).filter(r => r.status === 'awaiting_code').map(r => ({ e164: r.e164, code: r.code, id: r.id })) });
  });
  // The phone being connected "receives" the code; typing it here plays the part of giving it to LeadsIntel.
  sim.post('/code', (req, res) => {
    const r = st.reqs[req.body.id]; if (!r || r.status !== 'awaiting_code') return res.status(400).json({ error: 'No setup is waiting for a code.' });
    if (String(req.body.code).trim() !== r.code) return res.status(400).json({ error: 'Wrong code.' });
    r.status = 'connected';
    st.conns[`${r.body.externalPlatformTenantId}/${r.body.externalConnectionId}`] = { externalPlatformTenantId: r.body.externalPlatformTenantId,
      externalConnectionId: r.body.externalConnectionId, phoneNumberId: 'pn_demo_' + crypto.randomBytes(3).toString('hex'), displayPhoneNumber: r.e164,
      e164: r.e164, status: 'active', inboundWebhookUrl: r.body.inboundWebhookUrl, secret: r.body.inboundWebhookSecret };
    save(); res.json({ ok: true });
  });
  // A customer sends a WhatsApp message to a business number: deliver it exactly like LeadsIntel would.
  sim.post('/send', async (req, res) => {
    const from = digits(req.body.from); const c = connByPhone(req.body.to);
    if (!/^\d{9,15}$/.test(from)) return res.status(400).json({ error: 'Enter the customer phone number.' });
    if (!c) return res.status(400).json({ error: 'That business number is not connected.' });
    const m = req.body.location ? { type: 'location', location: req.body.location } : { type: 'text', text: { body: String(req.body.text || '').slice(0, 1000) } };
    log(from, c.e164, req.body.location ? `📍 ${req.body.location.name || 'Location'}` : m.text.body);
    const value = { messaging_product: 'whatsapp', metadata: { display_phone_number: digits(c.e164), phone_number_id: c.phoneNumberId },
      contacts: [{ profile: { name: 'Demo customer' }, wa_id: from }],
      messages: [{ from, id: 'wamid.in' + crypto.randomBytes(6).toString('hex'), timestamp: String(Math.floor(Date.now() / 1000)), ...m }] };
    if (!localCallback(c.inboundWebhookUrl)) {
      log(c.e164, from, `(This number sends chats to ${c.inboundWebhookUrl}, not to GrinFud, so GrinFud never sees this message.)`, { system: true });
      return res.json({ ok: true });
    }
    const raw = JSON.stringify(value); const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', c.secret).update(`${ts}.${raw}`).digest('hex');
    try {
      const hosted = new URL(publicUrls.requireOrigin());
      // Internal demo delivery stays on loopback, while generated links retain
      // the real site address. Never fetch an arbitrary saved webhook in demo.
      const r = await fetch(`http://127.0.0.1:${process.env.PORT}/webhooks/leadsintel`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
        'X-Forwarded-Host': hosted.host, 'X-Forwarded-Proto': hosted.protocol.slice(0, -1),
        'X-LeadIntel-Event-Id': 'evt_' + crypto.randomBytes(6).toString('hex'), 'X-LeadIntel-Timestamp': ts, 'X-LeadIntel-Signature': sig } });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      if (r.status === 200 && j && j.text) log(c.e164, from, j.text);
      else if (r.status >= 300) log(c.e164, from, `(webhook answered ${r.status}: ${t.slice(0, 120)})`, { system: true });
      res.json({ ok: true });
    } catch (e) { log(c.e164, from, `(could not reach webhook: ${e.message})`, { system: true }); res.json({ ok: true }); }
  });
  sim.post('/reset', (req, res) => { st.msgs = []; save(); res.json({ ok: true }); });
  app.use('/demo/sim', sim);
  app.get('/simulator', (req, res) => res.sendFile(path.join(__dirname, 'simulator.html')));
};
