const { test } = require('node:test');
const assert = require('node:assert/strict');
const register = require('./whatsapp-claim');
function fixture() {
  let row, wa = {}, sent = 0;
  const routes = {};
  const auth = () => {};
  const li = {
    lookupClaim: async () => ({ ok: true, data: { connected: true, claimable: true } }),
    newSecret: () => 'test-signing-secret',
    createClaim: async () => { sent++; return { ok: true, data: { claimId: 17, expiresAt: new Date(Date.now() + 600000).toISOString() } }; },
    getConnection: async () => ({ ok: false, status: 404 }),
    verifyClaim: async (id, code) => {
      assert.equal(id, '17'); assert.equal(code, '012345');
      return { ok: true, data: { status: 'connected', externalPlatformTenantId: row.tenant,
        externalConnectionId: row.connection, phoneNumberId: 'test-phone-id', displayPhoneNumber: '+254700000000' } };
    },
  };
  const options = { db: {
    one: async () => row ? { state_json: JSON.stringify(row) } : null,
    q: async (sql, params) => { row = JSON.parse(params[0]); },
  }, li, requireAdmin: auth, wrap: fn => fn, waGet: () => wa, waSet: async patch => { wa = patch; },
  webhookUrl: () => 'https://example.com/webhooks/leadsintel', parseNumber: () => ({ e164: '+254700000000' }),
  needKey: () => {}, needHttps: () => {}, demo: false };
  const app = { post: (path, middleware, fn) => { assert.equal(middleware, auth); routes[path.split('/').pop()] = fn; } };
  const service = register(app, options);
  const call = async (action, body = {}) => {
    let status = 200, data;
    const res = { status(s) { status = s; return this; }, json(d) { data = d; return this; } };
    await routes[action]({ body }, res); return { status, data };
  };
  return { li, service, call, row: () => row, wa: () => wa, sent: () => sent, resume: () => register(app, options) };
}
test('claim stays private and survives restart; connection saved only after verification', async () => {
  const f = fixture();
  const started = await f.call('start');
  assert.equal(started.status, 200);
  assert.equal(started.data.status, 'code_sent');
  assert.equal(JSON.stringify(started).includes('test-signing-secret'), false);
  assert.deepEqual(f.wa(), {});
  assert.equal((await f.call('start')).status, 409);
  assert.equal(f.sent(), 1);
  assert.equal((await f.resume().status()).status, 'code_sent');
  assert.equal((await f.call('verify', { code: '012345' })).data.status, 'connected');
  assert.equal(f.wa().mode, 'existing');
  assert.equal(f.wa().webhook_secret, 'test-signing-secret');
  assert.equal(await f.service.status(), null);
});
test('invalid and expired codes do not connect; no hidden SMS resend', async () => {
  const f = fixture(); await f.call('start');
  assert.equal((await f.call('verify', { code: '123' })).status, 400);
  f.li.verifyClaim = async () => ({ ok: false, status: 400, data: { error: 'invalid_code', attemptsLeft: 2 } });
  assert.match((await f.call('verify', { code: '111111' })).data.error, /2 attempts/);
  f.li.verifyClaim = async () => ({ ok: false, status: 410, data: { error: 'code_expired' } });
  assert.equal((await f.call('verify', { code: '111111' })).status, 410);
  assert.equal((await f.service.status()).status, 'expired');
  assert.deepEqual(f.wa(), {}); assert.equal(f.sent(), 1);
});
test('uncertain send is not repeated and a lost successful verification is recoverable', async () => {
  const f = fixture();
  f.li.createClaim = async () => ({ ok: false, status: 0 });
  assert.equal((await f.call('start')).status, 502);
  assert.equal((await f.call('start')).status, 409);
  const g = fixture(); await g.call('start');
  g.li.getConnection = async () => ({ ok: true, data: { status: 'active', phoneNumberId: 'test-phone-id' } });
  g.li.verifyClaim = () => { throw new Error('must not retry a successful verification'); };
  assert.equal((await g.call('verify', { code: '012345' })).data.status, 'connected');
});
test('unclaimable number and mismatched returned IDs never become linked', async () => {
  const f = fixture();
  f.li.lookupClaim = async () => ({ ok: true, data: { claimable: false } });
  assert.equal((await f.call('start')).status, 409);
  assert.equal(f.sent(), 0);
  const g = fixture(); await g.call('start');
  g.li.verifyClaim = async () => ({ ok: true, data: { status: 'connected', externalPlatformTenantId: 'wrong', externalConnectionId: 'wrong', phoneNumberId: 'wrong' } });
  assert.equal((await g.call('verify', { code: '012345' })).status, 502);
  assert.deepEqual(g.wa(), {});
});
