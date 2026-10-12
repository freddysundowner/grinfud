// Admin-managed credentials: encrypted at rest, write-only over the API.
const crypto = require('crypto');
const names = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', leadsintel: 'LEADSINTEL_PLATFORM_KEY', sunpay: 'SUNPAY_API_KEY' };
let database, saved = new Map();
function encryptionKey() {
  if (!process.env.SESSION_SECRET) throw new Error('A persistent SESSION_SECRET is required before saving API keys.');
  return crypto.createHash('sha256').update('grinfud-provider-credentials\0' + process.env.SESSION_SECRET).digest();
}
function encrypt(value, name) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function decrypt(value, name) {
  if (!value) return '';
  const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
async function init(db) {
  database = db;
  await db.q('CREATE TABLE IF NOT EXISTS provider_credentials (provider TEXT PRIMARY KEY, encrypted_value TEXT NOT NULL)');
  saved = new Map((await db.q('SELECT provider,encrypted_value FROM provider_credentials')).map(r => [r.provider, r.encrypted_value]));
}
function get(name) {
  if (!Object.hasOwn(names, name)) throw new Error('Unknown provider.');
  // An explicit removal disables the provider rather than resurrecting an environment key.
  if (saved.has(name)) return decrypt(saved.get(name), name);
  return process.env[names[name]] || '';
}
function status(name) {
  try { return { configured: !!get(name), source: saved.has(name) ? (saved.get(name) ? 'admin' : 'disabled') : process.env[names[name]] ? 'server' : 'none' }; }
  catch { return { configured: false, source: 'unreadable' }; }
}
async function update(name, value, remove) {
  if (!Object.hasOwn(names, name)) throw new Error('Unknown provider.');
  if (remove !== true && (typeof value !== 'string' || !value.trim())) return status(name);
  if (!remove && (value.trim().length < 16 || value.length > 512 || /\s/.test(value.trim()))) throw new Error('Enter a valid API key without spaces (16–512 characters).');
  if (!remove && name === 'sunpay' && !value.trim().startsWith('sp_')) throw new Error('SunPay API keys must start with sp_.');
  const encrypted = remove === true ? '' : encrypt(value.trim(), name);
  await database.q('INSERT INTO provider_credentials (provider,encrypted_value) VALUES ($1,$2) ON CONFLICT(provider) DO UPDATE SET encrypted_value=excluded.encrypted_value', [name, encrypted]);
  saved.set(name, encrypted);
  return status(name);
}
module.exports = { init, get, status, update };
