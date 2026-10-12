// SunPay STK collection only. No payouts, settlement overrides or automatic retries.
const crypto = require('node:crypto');
const credentials = require('./credentials');
const urls = require('./public-urls');
const ACTIVE = ['initiating', 'pending', 'unknown', 'completed'];
const error = (message, status = 400) => Object.assign(new Error(message), { status });
function phoneNumber(value) {
  let p = String(value || '').replace(/[\s()+-]/g, '');
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
  if (!/^254[17]\d{8}$/.test(p)) throw error('Enter a valid Kenyan M-Pesa number, e.g. 0712 345 678.');
  return p;
}
function verifiedPayment(attempt, tx) {
  // Never trust callback "completed", client amount, or an accepted STK response.
  if (!tx || String(tx.id) !== String(attempt.transaction_id) ||
      !['pending', 'completed', 'failed'].includes(tx.status) ||
      Math.round(Number(tx.amount) * 100) !== Math.round(Number(attempt.amount) * 100) ||
      phoneNumber(tx.phoneNumber) !== attempt.phone ||
      (tx.externalRef && tx.externalRef !== attempt.external_ref)) throw error('Payment verification mismatch. Contact the kitchen.', 409);
  if (tx.status === 'completed' && !tx.mpesaRef) throw error('Payment receipt is not available yet. Check again shortly.', 409);
  return { status: tx.status, receipt: tx.status === 'completed' ? String(tx.mpesaRef).slice(0, 80) : '' };
}
function makeClient({ getKey = () => credentials.get('sunpay'), fetcher = fetch } = {}) {
  return async (path, body) => {
    const key = getKey();
    if (!key) throw error('SunPay is not configured. Contact the kitchen.', 503);
    let response;
    try {
      response = await fetcher('https://api.sunpay.co.ke/api/v1' + path, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw error('SunPay could not confirm the request. Do not pay again yet; check payment status.', 503); }
    if (!response.ok) {
      // A 5xx or timeout could have accepted a charge. Retain an unresolved attempt.
      const e = error(response.status === 401 || response.status === 403 ? 'SunPay rejected the account credentials. Contact the kitchen.' : 'SunPay could not process the request. Please check payment status.', 503);
      e.definitive = [400, 401, 403, 422].includes(response.status); throw e;
    }
    try { return await response.json(); } catch { throw error('SunPay returned an unreadable response. Check payment status before retrying.', 503); }
  };
}
function createService(db, { client = makeClient(), configured = () => credentials.status('sunpay').configured, currency = () => 'KES' } = {}) {
  async function init() {
    await db.q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_receipt TEXT NOT NULL DEFAULT '';
      CREATE TABLE IF NOT EXISTS sunpay_config (id INTEGER PRIMARY KEY CHECK (id=1), enabled BOOLEAN NOT NULL DEFAULT FALSE);
      INSERT INTO sunpay_config(id) VALUES(1) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS sunpay_attempts (
        id TEXT PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id), external_ref TEXT UNIQUE NOT NULL,
        callback_token TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, amount NUMERIC NOT NULL,
        transaction_id TEXT UNIQUE, status TEXT NOT NULL, receipt TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), checked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS sunpay_active_order ON sunpay_attempts(order_id) WHERE status IN ('initiating','pending','unknown','completed');`);
  }
  const enabled = async () => !!(await db.one('SELECT enabled FROM sunpay_config WHERE id=1'))?.enabled && configured();
  const latest = id => db.one('SELECT * FROM sunpay_attempts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1', [id]);
  async function view(order) {
    const a = await latest(order.id), on = await enabled(), status = a?.status || 'unpaid';
    const messages = {
      unpaid: on ? 'Pay securely with an M-Pesa prompt on your phone.' : 'Online M-Pesa payments are not enabled. Contact the kitchen.',
      initiating: 'Sending the payment request. Please wait; do not send another.',
      pending: 'Check your phone for the M-Pesa prompt. Enter your PIN only on your phone.',
      unknown: 'The request outcome is uncertain. Do not pay again yet. Check status or contact the kitchen.',
      failed: 'Payment did not complete. You can try again after one minute.',
      completed: 'Payment received. Thank you.'
    };
    return { enabled: on, status, amount: Number(a?.amount ?? order.total), currency: 'KES', phone: a?.phone || order.phone,
      receipt: a?.receipt || '', message: Number(order.total) === 0 && !a ? 'No payment is required for this order.' : messages[status],
      can_pay: on && Number(order.total) >= 1 && order.status !== 'cancelled' && ['unpaid', 'failed'].includes(status) &&
        (!a || Date.now() - new Date(a.created_at).getTime() >= 60000) };
  }
  async function apply(attempt, tx) {
    const verified = verifiedPayment(attempt, tx);
    await db.transaction(async t => {
      await t.one('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [attempt.order_id]);
      const current = await t.one('SELECT * FROM sunpay_attempts WHERE id=$1 FOR UPDATE', [attempt.id]);
      if (current.status === 'completed') return;
      // Failed attempts are terminal. Unexpected contradictory settlements need manual reconciliation.
      if (current.status === 'failed') {
        if (verified.status !== 'failed') throw error('Payment status needs manual reconciliation. Contact the kitchen.', 409);
        return; // A late callback for an old failure must not overwrite a newer attempt.
      }
      await t.q('UPDATE sunpay_attempts SET status=$1,receipt=$2,checked_at=now(),updated_at=now() WHERE id=$3', [verified.status, verified.receipt, attempt.id]);
      await t.q('UPDATE orders SET payment_status=$1,payment_receipt=$2 WHERE id=$3', [verified.status, verified.receipt, attempt.order_id]);
    });
  }
  async function refresh(a) {
    if (!a || !a.transaction_id || ['completed', 'failed'].includes(a.status)) return;
    const claimed = await db.one(`UPDATE sunpay_attempts SET checked_at=now() WHERE id=$1 AND
      (checked_at IS NULL OR checked_at < now()-interval '5 seconds') RETURNING *`, [a.id]);
    if (!claimed) return;
    await apply(claimed, await client('/payments/' + encodeURIComponent(claimed.transaction_id)));
  }
  async function start(order, inputPhone, origin) {
    if (!await enabled()) throw error('M-Pesa payments are not enabled. Contact the kitchen.', 503);
    if (!['KES', 'KSH'].includes(String(currency()).toUpperCase())) throw error('SunPay payments require prices in Kenyan shillings.');
    if (!/^https:\/\//.test(origin)) throw error('Open the hosted HTTPS website to pay.');
    const phone = phoneNumber(inputPhone);
    const reserved = await db.transaction(async t => {
      const current = await t.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [order.id]);
      if (!current || current.status === 'cancelled') throw error('This order cannot be paid.', 409);
      const previous = await t.one('SELECT * FROM sunpay_attempts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1', [order.id]);
      if (previous && ACTIVE.includes(previous.status)) return { attempt: previous, reused: true };
      if (previous && Date.now() - new Date(previous.created_at).getTime() < 60000) throw error('Wait one minute before requesting another prompt.', 429);
      const amount = Number(current.total);
      if (!Number.isSafeInteger(amount) || amount < 1) throw error('Order amount must be at least KSh 1.');
      const id = crypto.randomUUID(), externalRef = `${current.code}-${id}`, callbackToken = crypto.randomBytes(24).toString('hex');
      const attempt = await t.one(`INSERT INTO sunpay_attempts(id,order_id,external_ref,callback_token,phone,amount,status)
        VALUES($1,$2,$3,$4,$5,$6,'initiating') RETURNING *`, [id, order.id, externalRef, callbackToken, phone, amount]);
      await t.q("UPDATE orders SET payment_status='initiating' WHERE id=$1", [order.id]);
      return { attempt, reused: false };
    });
    if (reserved.reused) return view(order);
    const a = reserved.attempt;
    try {
      const result = await client('/payments/stk-push', { phoneNumber: a.phone, amount: Number(a.amount),
        externalRef: a.external_ref, callbackUrl: `${origin}/webhooks/sunpay/${a.callback_token}` });
      if (result.success !== true || typeof result.transactionId !== 'string' || !result.transactionId || result.transactionId.length > 200) throw error('SunPay did not confirm the payment prompt. Check status before retrying.', 503);
      await db.transaction(async t => {
        await t.one('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [order.id]);
        await t.q(`UPDATE sunpay_attempts SET transaction_id=COALESCE(transaction_id,$1),
          status=CASE WHEN status IN ('initiating','unknown') THEN 'pending' ELSE status END,updated_at=now() WHERE id=$2`, [result.transactionId, a.id]);
        await t.q('UPDATE orders SET payment_status=(SELECT status FROM sunpay_attempts WHERE id=$1) WHERE id=$2', [a.id, order.id]);
      });
    } catch (e) {
      await db.transaction(async t => {
        await t.one('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [order.id]);
        await t.q("UPDATE sunpay_attempts SET status=$1,updated_at=now() WHERE id=$2 AND status='initiating'", [e.definitive ? 'failed' : 'unknown', a.id]);
        await t.q('UPDATE orders SET payment_status=(SELECT status FROM sunpay_attempts WHERE id=$1) WHERE id=$2', [a.id, order.id]);
      });
      throw e;
    }
    return view(order);
  }
  async function callback(token, body) {
    const a = await db.one('SELECT * FROM sunpay_attempts WHERE callback_token=$1', [token]);
    if (!a) return;
    const id = body?.transactionId;
    if (typeof id !== 'string' || !id || id.length > 200 || (a.transaction_id && a.transaction_id !== id)) throw error('Payment reference mismatch.', 409);
    if (body.externalRef && body.externalRef !== a.external_ref) throw error('Payment reference mismatch.', 409);
    // callbackUrl is unsigned. Its unguessable per-attempt capability binds the
    // transaction, and authenticated SunPay lookup verifies the actual result.
    const tx = await client('/payments/' + encodeURIComponent(id));
    verifiedPayment({ ...a, transaction_id: id }, tx);
    await db.q('UPDATE sunpay_attempts SET transaction_id=COALESCE(transaction_id,$1) WHERE id=$2', [id, a.id]);
    await apply({ ...a, transaction_id: id }, tx);
  }
  return { init, enabled, view, latest, refresh, start, callback };
}
function routes(app, { db, requireAdmin, trackedOrder, getSettings }) {
  const service = createService(db, { currency: () => getSettings().currency });
  const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => res.status(e.status || 500).json({ error: e.status ? e.message : 'Payment service unavailable. Please check status before trying again.' }));
  const guard = (req, res, next) => req.get('sec-fetch-site') === 'cross-site' || !req.is('application/json')
    ? res.status(403).json({ error: 'Use the payment form on this website.' }) : next();
  const hits = new Map();
  const limit = (req, res, next) => {
    const key = req.ip, now = Date.now(), recent = (hits.get(key) || []).filter(t => t > now - 60000);
    if (recent.length >= 8) return res.status(429).json({ error: 'Too many payment requests. Wait a minute.' });
    if (hits.size > 10000) hits.clear();
    recent.push(now); hits.set(key, recent); next();
  };
  app.get('/api/admin/sunpay', requireAdmin, wrap(async (req, res) => res.json({
    enabled: !!(await db.one('SELECT enabled FROM sunpay_config WHERE id=1'))?.enabled,
    configured: credentials.status('sunpay').configured, callback_url: urls.origin() + '/webhooks/sunpay/[automatic-per-payment]', live: true
  })));
  app.put('/api/admin/sunpay', requireAdmin, guard, wrap(async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') throw error('Choose whether payments are enabled.');
    if (req.body.enabled && !credentials.status('sunpay').configured) throw error('Save your SunPay API key in Settings → API keys first.');
    await db.q('UPDATE sunpay_config SET enabled=$1 WHERE id=1', [req.body.enabled]);
    res.json({ enabled: req.body.enabled, configured: credentials.status('sunpay').configured, live: true });
  }));
  app.get('/api/track/:token/payment', wrap(async (req, res) => {
    const order = await trackedOrder(req.params.token); if (!order) throw error('Order not found.', 404);
    let message;
    try { await service.refresh(await service.latest(order.id)); } catch { message = 'Could not verify the latest status with SunPay. Do not pay again yet; check again shortly.'; }
    const state = await service.view(order);
    res.json(message ? { ...state, message } : state);
  }));
  app.post('/api/track/:token/payment', guard, limit, wrap(async (req, res) => {
    const order = await trackedOrder(req.params.token); if (!order) throw error('Order not found.', 404);
    res.json(await service.start(order, req.body.phone, urls.requireOrigin()));
  }));
  app.post('/webhooks/sunpay/:nonce', wrap(async (req, res) => {
    if (!/^[a-f0-9]{48}$/.test(req.params.nonce)) return res.sendStatus(404);
    await service.callback(req.params.nonce, req.body); res.sendStatus(200);
  }));
  return service;
}
module.exports = { makeClient, phoneNumber, verifiedPayment, createService, routes, ACTIVE };
