// Direct provider calls. No SDK, proxy, silent fallback or credential logging.
const TEXT_MODEL = 'gpt-5-nano';
const AUDIO_MODEL = 'gpt-4o-mini-transcribe';
async function generate({ key, system, parts, schema, timeout, maxTokens }) {
  const audio = parts.find(p => p.inlineData);
  let url, body, headers = { Authorization: `Bearer ${key}` };
  if (audio) {
    url = 'https://api.openai.com/v1/audio/transcriptions';
    body = new FormData();
    body.append('model', AUDIO_MODEL);
    body.append('file', new Blob([Buffer.from(audio.inlineData.data, 'base64')], { type: 'audio/wav' }), 'voice.wav');
    body.append('response_format', 'json');
    body.append('prompt', 'Food ordering in English or Swahili. Nduma, ngwaci, kienyeji.');
  } else {
    url = 'https://api.openai.com/v1/chat/completions';
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      model: TEXT_MODEL, reasoning_effort: 'minimal',
      max_completion_tokens: Math.max(maxTokens, 2400),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system + '\nReturn JSON matching this schema: ' + JSON.stringify(schema) },
        { role: 'user', content: parts.map(p => p.text || '').join('\n') },
      ],
    });
  }
  let response;
  try { response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) }); }
  catch { throw Object.assign(new Error('OpenAI could not be reached. Please retry or use the menu buttons.'), { status: 503 }); }
  if (!response.ok) throw Object.assign(new Error(response.status === 429
    ? 'OpenAI quota or rate limit reached. Check API billing or try later.'
    : 'OpenAI request failed. Check your saved key and model access in Admin.'), { status: response.status === 429 ? 429 : 503 });
  const data = await response.json();
  if (audio) return { text: data.text };
  try { return JSON.parse(data.choices?.[0]?.message?.content || ''); }
  catch { throw Object.assign(new Error('The assistant returned an unreadable answer. Please retry.'), { status: 502 }); }
}
module.exports = { generate, TEXT_MODEL, AUDIO_MODEL };
