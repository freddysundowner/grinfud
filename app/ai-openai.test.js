const { test } = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('./ai-openai');
test('OpenAI text, audio and quota failures use the right contracts', async () => {
  const original = global.fetch;
  const base = { key: 'test-only-not-a-real-key', system: 'Return JSON', schema: { type: 'OBJECT' }, timeout: 500, maxTokens: 100 };
  try {
    global.fetch = async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-5-nano');
      assert.equal(body.reasoning_effort, 'minimal');
      assert.equal(body.response_format.type, 'json_object');
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"reply","reply":"Hello"}' } }] }) };
    };
    assert.equal((await adapter.generate({ ...base, parts: [{ text: 'Hello' }] })).action, 'reply');
    global.fetch = async (url, init) => {
      assert.ok(url.endsWith('/audio/transcriptions'));
      assert.equal(init.body.get('model'), 'gpt-4o-mini-transcribe');
      assert.equal(init.body.get('file').type, 'audio/wav');
      return { ok: true, json: async () => ({ text: 'Nduma please' }) };
    };
    assert.deepEqual(await adapter.generate({ ...base, parts: [{ inlineData: { data: Buffer.from('fixture').toString('base64') } }] }), { text: 'Nduma please' });
    global.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(adapter.generate({ ...base, parts: [{ text: 'Hello' }] }), { status: 429 });
  } finally { global.fetch = original; }
});
