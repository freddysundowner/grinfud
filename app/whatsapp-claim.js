// Claims are admin-only. Never return webhook secrets or log verification codes.
module.exports = function registerClaims(app, { db, li, requireAdmin, wrap, waGet, waSet, webhookUrl, parseNumber, needKey, needHttps, demo }) {
  const load = async () => {
    const row = await db.one('SELECT state_json FROM wa_claim WHERE id=1');
    return row ? JSON.parse(row.state_json) : null;
  };
  const save = state => db.q(`INSERT INTO wa_claim(id,state_json) VALUES(1,$1)
    ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json`, [JSON.stringify(state)]);
  const summary = c => c ? { status: c.status, phone: c.phone, expires_at: c.expires, attempts_left: c.attempts } : null;
  let busy = false;
  const guarded = fn => wrap(async (req, res) => {
    needKey(); needHttps();
    if (demo) return res.status(409).json({ error: 'SMS claims are available on the hosted production app, not the simulator.' });
    if (busy) return res.status(409).json({ error: 'A number-connection request is already running. Please wait.' });
    busy = true;
    try { await fn(req, res); } finally { busy = false; }
  });
  app.post('/api/admin/whatsapp/claims/lookup', requireAdmin, guarded(async (req, res) => {
    const r = await li.lookupClaim(parseNumber(req.body).e164);
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: r.status === 404 ? 'This number is not connected on Lead Intel. Use new-number setup.' : 'Could not check this number. Check your platform key or try later.' });
    res.json({ claimable: r.data?.claimable === true, connected: r.data?.connected === true });
  }));
  app.post('/api/admin/whatsapp/claims/start', requireAdmin, guarded(async (req, res) => {
    if (waGet().mode) return res.status(409).json({ error: 'Change or finish the current number connection first.' });
    const prior = await load();
    if (prior && prior.expires > Date.now() && !['expired', 'failed', 'connected'].includes(prior.status))
      return res.status(409).json({ error: 'A claim is already pending. Resume it or wait for its ten-minute expiry.' });
    const phone = parseNumber(req.body).e164;
    const check = await li.lookupClaim(phone);
    if (!check.ok || check.data?.claimable !== true) return res.status(409).json({ error: 'This number cannot currently be claimed. Check its ownership in Lead Intel.' });
    const crypto = require('node:crypto');
    const state = { phone, tenant: 'grinfud', connection: 'claim-' + crypto.randomUUID(), secret: li.newSecret(),
      status: 'sending', expires: Date.now() + 600000, attempts: 5 };
    await save(state); // Persist the secret/IDs before any external side effect.
    const r = await li.createClaim({ phoneNumber: phone, externalPlatformTenantId: state.tenant,
      externalConnectionId: state.connection, inboundWebhookUrl: webhookUrl(), inboundWebhookSecret: state.secret, inboundWebhookTimeoutMs: 30000 });
    if (!r.ok || !r.data?.claimId) {
      state.status = !r.status || r.status >= 500 || r.ok ? 'unknown' : 'failed';
      await save(state);
      return res.status(502).json({ error: state.status === 'unknown'
        ? 'Code sending could not be confirmed. Do not keep retrying; wait ten minutes before starting again.'
        : 'Lead Intel could not send a code. Check that the number is claimable and your platform key is valid.' });
    }
    state.id = String(r.data.claimId); state.status = 'code_sent';
    const expiry = Date.parse(r.data.expiresAt);
    if (Number.isFinite(expiry)) state.expires = Math.min(state.expires, expiry);
    await save(state); res.json(summary(state));
  }));
  app.post('/api/admin/whatsapp/claims/verify', requireAdmin, guarded(async (req, res) => {
    const c = await load();
    if (!c || !c.id) return res.status(409).json({ error: 'No code is awaiting verification.' });
    if (waGet().mode) return res.status(409).json({ error: 'A number is already linked. Refresh the connection screen.' });
    // Recover a successful provider verification whose response/save was lost.
    const connection = await li.getConnection(c.tenant, c.connection);
    let data = connection.ok && ['active', 'connected'].includes(connection.data?.status)
      ? { ...connection.data, status: 'connected', externalPlatformTenantId: c.tenant, externalConnectionId: c.connection } : null;
    if (!data) {
      if (c.expires <= Date.now() || c.status === 'expired') return res.status(410).json({ error: 'The code expired. Start a new claim.' });
      if (typeof req.body.code !== 'string' || !/^\d{6}$/.test(req.body.code)) return res.status(400).json({ error: 'Enter the six-digit SMS code.' });
      const r = await li.verifyClaim(c.id, req.body.code);
      if (!r.ok || r.data?.status !== 'connected') {
        if (Number.isInteger(r.data?.attemptsLeft)) c.attempts = Math.max(0, r.data.attemptsLeft);
        if (r.status === 410 || c.attempts === 0) c.status = 'expired';
        await save(c);
        return res.status(r.status === 400 ? 400 : r.status === 410 ? 410 : 502).json({ error:
          r.status === 400 ? `Incorrect code. ${c.attempts} attempts remaining.` : c.status === 'expired' ? 'Code expired or attempts exhausted. Start a new claim.' : 'Verification could not be confirmed. Retry verification, not code sending.' });
      }
      data = r.data;
    }
    if (data.externalPlatformTenantId !== c.tenant || data.externalConnectionId !== c.connection || !data.phoneNumberId)
      return res.status(502).json({ error: 'Lead Intel returned an unexpected connection. Contact support before retrying.' });
    await waSet({ mode: 'existing', tenant_id: data.externalPlatformTenantId, connection_id: data.externalConnectionId,
      phone_number_id: data.phoneNumberId, display_phone: data.displayPhoneNumber || c.phone, webhook_secret: c.secret, request_status: 'connected' });
    c.status = 'connected'; await save(c);
    res.json({ status: 'connected' });
  }));
  return { status: async () => {
    const c = await load();
    if (!c || c.status === 'connected') return null;
    if (c.expires <= Date.now()) c.status = 'expired';
    return summary(c);
  } };
};
