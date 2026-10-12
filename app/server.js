// GrinFud Orders — single-page ordering, admin menu manager, WhatsApp ordering chat via LeadsIntel.
// Run: node server.js   (see README.md for environment variables)
// Reads .env (KEY=value lines). Real environment variables win. Written by hand so it also runs on Node 18.
try {
  for (const line of require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: use real env vars */ }

// DEMO MODE (npm run demo): fake LeadsIntel + WhatsApp simulator, separate data folder, nothing real is sent.
const DEMO = process.argv.includes('--demo');
if (DEMO) {
  process.env.PORT = process.env.PORT || '3000';
  process.env.DATA_DIR = require('path').join(__dirname, 'data-demo');
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/grinfud'; // demo tables live in their own "grinfud_demo" schema
  process.env.ADMIN_PASSWORD = 'demo';
  process.env.LEADSINTEL_PLATFORM_KEY = 'li_platform_demo';
  process.env.LEADSINTEL_API_BASE = `http://127.0.0.1:${process.env.PORT}/demo/leadsintel/api`;
  process.env.BLESSEDTEXTS_API_URL = `http://127.0.0.1:${process.env.PORT}/demo/sms/sendsms`; // pretend SMS gateway
  delete process.env.KITCHEN_TEMPLATE_NAME; delete process.env.CUSTOMER_TEMPLATE_NAME;
}
const express = require('express');
const db = require('./db');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { sendOrderNotifications, sendText, sendKitchen, kitchenPhones, kitchenPhone, kitchenWaLink, money } = require('./notify');
const li = require('./leadsintel');
const createChat = require('./whatsapp');
const sms = require('./sms');
const QRCode = require('qrcode');
const publicUrls = require('./public-urls');
const photoStorage = require('./photo-storage');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// The placeholder from .env.example is treated as "not set", so a copied example file can never unlock the admin.
const ADMIN_PASSWORD = /^change-me/i.test(process.env.ADMIN_PASSWORD || '') ? '' : process.env.ADMIN_PASSWORD || '';
const BOT_API_KEY = process.env.BOT_API_KEY || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('gf:' + ADMIN_PASSWORD + BOT_API_KEY).digest('hex');

if (!DEMO && ADMIN_PASSWORD && ADMIN_PASSWORD.length < 10) console.warn('⚠  ADMIN_PASSWORD is short — use at least 10 characters in production.');
if (!DEMO && !process.env.SESSION_SECRET) console.warn('⚠  SESSION_SECRET is not set — admin logins are signed with a key derived from the password. Set a long random value.');
if (!ADMIN_PASSWORD) console.warn('⚠  ADMIN_PASSWORD is not set — the admin page is locked until you set it.');
if (!li.keyConfigured()) console.warn('⚠  LEADSINTEL_PLATFORM_KEY is not set — WhatsApp ordering and automatic alerts are off until you set it.');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- database (PostgreSQL) ----------
// Orders, chats and webhook ids are read from the database on every request. The menu, the settings and the linked
// WhatsApp number are small and rarely change, so they are held in memory and re-read after every change.
// Run ONE copy of this app per database: a second copy would not see the first one's changes until it restarts.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL, description TEXT DEFAULT '', price INTEGER NOT NULL DEFAULT 0,
  category TEXT DEFAULT 'Menu', image TEXT DEFAULT '', available INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0, options_json TEXT DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now());
-- How a kitchen thinks about a product: is it cooked or raw (or the buyer's choice), what is it sold by, how many it feeds, smallest order.
ALTER TABLE items ADD COLUMN IF NOT EXISTS prep TEXT DEFAULT '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS cooked_extra INTEGER DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS serves INTEGER DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS min_qty INTEGER DEFAULT 1;
ALTER TABLE items ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE items ADD COLUMN IF NOT EXISTS discount_value INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS images_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE,
  source TEXT, customer_name TEXT, phone TEXT, location TEXT,
  delivery_date TEXT, delivery_time TEXT, notes TEXT,
  items_json TEXT, subtotal INTEGER, delivery_fee INTEGER, total INTEGER,
  status TEXT DEFAULT 'new', notified INTEGER DEFAULT 0, notify_error TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS orders_phone_idx ON orders (phone);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_status TEXT DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
-- track_token is the secret part of the buyer's tracking link (/t/<token>); lat/lng is the delivery pin, when the buyer shared one.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_token TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS orders_track_token_idx ON orders (track_token);
-- Everyone who has chatted on WhatsApp or placed an order. "username" is an optional nickname the buyer picks.
CREATE TABLE IF NOT EXISTS customers (phone TEXT PRIMARY KEY, name TEXT, username TEXT, source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), last_seen_at TIMESTAMPTZ DEFAULT now());
INSERT INTO customers (phone, name, source, created_at, last_seen_at)
  SELECT DISTINCT ON (phone) phone, customer_name, source, created_at, created_at FROM orders WHERE phone <> '' ORDER BY phone, id DESC
  ON CONFLICT (phone) DO NOTHING;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, at BIGINT);
CREATE TABLE IF NOT EXISTS chats (phone TEXT PRIMARY KEY, state_json TEXT, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS wa_link (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT, tenant_id TEXT, connection_id TEXT,
  phone_number_id TEXT, display_phone TEXT, webhook_secret TEXT, request_id TEXT, request_status TEXT, request_error TEXT, updated_at TIMESTAMPTZ);
`;
const DEFAULT_SETTINGS = {
  ai_provider: 'gemini',
  business_name: 'GrinFud',
  tagline: 'Farm fresh to your doorstep',
  currency: 'KSh',
  notify_phone: '',
  delivery_fee: '0',
  accepting_orders: '1',
  website_chat_enabled: '1',
  whatsapp_chat_enabled: '1',
  closed_message: 'We are not taking orders right now. Please check back soon.',
  delivery_times: JSON.stringify(['6:30 – 7:30 am', '7:30 – 8:30 am']),
  payment_note: 'Pay with M-Pesa or cash on delivery.',
  notify_customer: '1',
  // SMS alerts through Blessed Texts. The admin fills these in; the key is write-only (never sent to the browser).
  sms_enabled: '0', sms_api_key: '', sms_sender_id: '', sms_phone: '',
};
let SETTINGS = {}, ITEMS = [], WA = {};
const getSettings = () => ({ ...SETTINGS });
require('./ai').setProvider(() => getSettings().ai_provider || 'gemini');
const loadSettings = async () => { SETTINGS = Object.fromEntries((await db.q('SELECT key, value FROM settings')).map(r => [r.key, r.value])); };
const loadItems = async () => { ITEMS = await db.q('SELECT * FROM items ORDER BY category, sort, id'); };

// The WhatsApp number customers chat with (one row). Chosen in Admin → Settings; its webhook secret never leaves the server.
const WA_COLS = ['mode', 'tenant_id', 'connection_id', 'phone_number_id', 'display_phone', 'webhook_secret', 'request_id', 'request_status', 'request_error'];
const waGet = () => ({ ...WA });
const loadWa = async () => { WA = (await db.one('SELECT * FROM wa_link WHERE id = 1')) || {}; };
const waSet = async patch => {
  const row = { ...WA, ...patch };
  await db.q(`INSERT INTO wa_link (id, ${WA_COLS.join(',')}, updated_at) VALUES (1, ${WA_COLS.map((c, i) => '$' + (i + 1)).join(',')}, now())
    ON CONFLICT (id) DO UPDATE SET ${WA_COLS.map(c => `${c}=excluded.${c}`).join(',')}, updated_at=excluded.updated_at`, WA_COLS.map(c => row[c] ?? null));
  await loadWa();
};
const waClear = async () => { await db.q('DELETE FROM wa_link'); WA = {}; };
li.init({ get: waGet, set: waSet });

// Remember a buyer. Empty name / nickname never overwrite one we already have.
const touchCustomer = (phone, { name = '', username = '', source = '' } = {}) => db.q(`INSERT INTO customers (phone, name, username, source)
  VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4)
  ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF($2, ''), customers.name), username = COALESCE(NULLIF($3, ''), customers.username), last_seen_at = now()`,
  [phone, name, username, source]).catch(e => console.error('[customers] could not save', e.message));

const newToken = () => crypto.randomBytes(16).toString('base64url');
// A pin is only kept when it is a real coordinate.
function cleanPin(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return lat != null && lng != null && lat !== '' && lng !== '' && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0)
    ? { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 } : null;
}
const mapLink = o => (o.lat != null && o.lng != null ? `https://maps.google.com/?q=${o.lat},${o.lng}` : '');
// Absolute on the hosted site; never generate a public localhost address.
const trackUrl = token => (token ? publicUrls.absolute(`/t/${token}`) : '');

async function initDb() {
  await db.init(DEMO ? 'grinfud_demo' : '');
  await db.q(SCHEMA_SQL);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await db.q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
  // Seed the launch product once, so the page is never empty on first run.
  if ((await db.one('SELECT COUNT(*) n FROM items')).n === 0) {
    const seedImg = path.join(__dirname, 'seed', 'breakfast-basket.jpg');
    let image = '';
    if (fs.existsSync(seedImg)) {
      // Verify durable bytes before saving the URL, including on a fresh deployment.
      await photoStorage.ensurePhoto('breakfast-basket.jpg', await fs.promises.readFile(seedImg));
      image = '/uploads/breakfast-basket.jpg';
    }
    await db.q("INSERT INTO items (name, description, price, category, image, options_json, sort, prep, unit, serves) VALUES ($1,$2,$3,$4,$5,$6,$7,'cooked','basket',1)", [
      'Breakfast Basket', '2 kienyeji eggs, 1 serving of nduma or ngwaci and 1 piece of seasonal fruit.', 299, 'Breakfast', image,
      JSON.stringify([{ name: 'Nduma or ngwaci?', type: 'single', required: true, choices: [{ label: 'Nduma', price: 0 }, { label: 'Ngwaci', price: 0 }] }]), 1]);
  }
  for (const r of await db.q('SELECT id FROM orders WHERE track_token IS NULL')) await db.q('UPDATE orders SET track_token = $1 WHERE id = $2', [newToken(), r.id]);
  await Promise.all([loadSettings(), loadItems(), loadWa()]);
}

// ---------- helpers ----------
// An item sold "cooked or raw" gets that question asked automatically, ahead of the admin's own questions, wherever it is ordered.
const PREP_QUESTION = 'Cooked or raw?';
const prepOption = r => (r.prep === 'both' ? [{ name: PREP_QUESTION, type: 'single', required: true, choices: [{ label: 'Raw', price: 0 }, { label: 'Cooked', price: r.cooked_extra || 0 }] }] : []);
const rowToItem = r => ({ id: r.id, name: r.name, description: r.description, ...require('./discounts').discountedPrice(r), category: r.category,
  image: require('./item-images').itemImages(r)[0] || '', images: require('./item-images').itemImages(r), available: !!r.available, sort: r.sort, prep: r.prep || '', cooked_extra: r.cooked_extra || 0, unit: r.unit || '',
  serves: r.serves || 0, min_qty: Math.max(1, r.min_qty || 1), options: [...prepOption(r), ...safeJSON(r.options_json, [])] });
// The admin editor works on the admin's own questions only; `order_options` is what a buyer is actually asked.
const rowToAdminItem = r => { const it = rowToItem(r); return { ...it, price: r.price, sale_price: it.price, order_options: it.options, options: safeJSON(r.options_json, []) }; };
const stamp = d => (d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : d || '');
const rowToOrder = r => ({ code: r.code, source: r.source, customer_name: r.customer_name, phone: r.phone, location: r.location,
  delivery_date: r.delivery_date, delivery_time: r.delivery_time, notes: r.notes, items: safeJSON(r.items_json, []),
  subtotal: r.subtotal, delivery_fee: r.delivery_fee, total: r.total, status: r.status, notified: !!r.notified,
  notify_error: r.notify_error, sms_status: r.sms_status || '', payment_status: r.payment_status || 'unpaid', payment_receipt: r.payment_receipt || '', lat: r.lat ?? null, lng: r.lng ?? null, map_link: mapLink(r), track_url: trackUrl(r.track_token),
  created_at: stamp(r.created_at), updated_at: stamp(r.updated_at), delivered_at: stamp(r.delivered_at), receipt_types: require('./receipts').receiptTypes(r) });
function safeJSON(s, d) { try { return JSON.parse(s); } catch { return d; } }
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function normPhone(p) {
  let d = String(p || '').replace(/[^\d]/g, '');
  if (d.startsWith('0') && d.length === 10) d = '254' + d.slice(1);
  if ((d.startsWith('7') || d.startsWith('1')) && d.length === 9) d = '254' + d;
  return d;
}
const validPhone = p => /^254(7|1)\d{8}$/.test(p);
const STATUSES = ['new', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];

function cleanOptions(opts) {
  if (!Array.isArray(opts)) return [];
  return opts.slice(0, 20).map(g => ({
    name: str(g.name, 80) || 'Option',
    type: g.type === 'multi' ? 'multi' : 'single',
    required: !!g.required,
    choices: (Array.isArray(g.choices) ? g.choices : []).slice(0, 30)
      .map(c => ({ label: str(c.label, 80), price: Math.max(0, Math.round(Number(c.price) || 0)) })).filter(c => c.label),
  })).filter(g => g.choices.length);
}

// Prices are always computed here, never trusted from the client or the bot.
function priceCart(lines, { allowHidden = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Your order is empty.');
  if (lines.length > 30) throw new Error('Too many lines in one order.');
  const s = getSettings();
  const out = []; let subtotal = 0;
  for (const line of lines) {
    const id = Number(line.item_id ?? line.id);
    let row = Number.isInteger(id) ? ITEMS.find(i => i.id === id) : null;
    if (!row && line.name) row = ITEMS.find(i => i.name.toLowerCase() === String(line.name).trim().toLowerCase());
    if (!row || (!row.available && !allowHidden)) throw new Error(`"${line.name || line.item_id}" is not available.`);
    const item = rowToItem(row);
    const qty = Math.round(Number(line.qty ?? line.quantity ?? 1));
    if (!(qty >= 1 && qty <= 50)) throw new Error(`Quantity for ${item.name} must be between 1 and 50.`);
    if (qty < item.min_qty && !allowHidden) throw new Error(`The smallest order for ${item.name} is ${item.min_qty}${item.unit ? ' ' + item.unit : ''}.`);
    const picked = line.options && typeof line.options === 'object' ? line.options : {};
    let unit = item.price; const chosen = [];
    for (const g of item.options) {
      let sel = picked[g.name]; if (sel == null) sel = [];
      if (!Array.isArray(sel)) sel = [sel];
      sel = sel.map(x => String(x).trim().toLowerCase());
      const matches = g.choices.filter(c => sel.includes(c.label.toLowerCase()));
      if (g.required && !matches.length) throw new Error(`Please choose "${g.name}" for ${item.name} (${g.choices.map(c => c.label).join(' / ')}).`);
      if (g.type === 'single' && matches.length > 1) throw new Error(`Choose only one for "${g.name}".`);
      for (const c of matches) { unit += c.price; chosen.push({ group: g.name, choice: c.label, price: c.price }); }
    }
    const lineTotal = unit * qty; subtotal += lineTotal;
    out.push({ item_id: item.id, name: item.name, qty, unit_price: unit, line_total: lineTotal, original_unit_price: unit + item.original_price - item.price, discount_per_unit: item.original_price - item.price, options: chosen, note: str(line.note, 200) });
  }
  const delivery_fee = Math.max(0, Math.round(Number(s.delivery_fee) || 0));
  return { lines: out, subtotal, delivery_fee, total: subtotal + delivery_fee, currency: s.currency };
}

// Tiny in-memory abuse guards: orders per device, and password guesses on the admin login.
const WINDOW_MS = 10 * 60 * 1000;
const recent = new Map(), loginFails = new Map();
const hits = (map, ip) => (map.get(ip) || []).filter(t => Date.now() - t < WINDOW_MS);
function rateLimited(ip) { const arr = hits(recent, ip); arr.push(Date.now()); recent.set(ip, arr); return arr.length > 8; }
setInterval(() => { for (const map of [recent, loginFails, trackLimited]) for (const ip of map.keys()) { const arr = hits(map, ip); arr.length ? map.set(ip, arr) : map.delete(ip); } }, WINDOW_MS).unref();

async function createOrder(body, source, orderToken = newToken()) {
  const s = getSettings();
  if (s.accepting_orders !== '1') { const e = new Error(s.closed_message); e.status = 409; throw e; }
  const name = str(body.customer_name || body.name, 80);
  const phone = normPhone(body.phone);
  const location = str(body.location || body.address, 300);
  if (!name) throw new Error('Please add your name.');
  if (!validPhone(phone)) throw new Error('Please add a valid Kenyan phone number, e.g. 0712 345 678.');
  if (!location) throw new Error('Please add a delivery location.');
  const priced = priceCart(body.items);
  const pin = cleanPin(body.lat, body.lng);
  // The order code (GF-1001, GF-1002…) comes from the row's own id, so two orders placed at once can never share one.
  const order = rowToOrder(await db.one(`WITH n AS (SELECT nextval(pg_get_serial_sequence('orders', 'id')) AS id)
    INSERT INTO orders (id, code, source, customer_name, phone, location, delivery_date, delivery_time, notes, items_json, subtotal, delivery_fee, total, track_token, lat, lng)
    SELECT n.id, 'GF-' || (1000 + n.id), $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::int, $10::int, $11::int, $12::text, $13::float8, $14::float8 FROM n RETURNING *`,
    [source, name, phone, location, str(body.delivery_date, 20), str(body.delivery_time, 60), str(body.notes, 500), JSON.stringify(priced.lines), priced.subtotal, priced.delivery_fee, priced.total,
      orderToken, pin ? pin.lat : null, pin ? pin.lng : null]));
  const code = order.code;
  touchCustomer(phone, { name, username: str(body.username, 30).replace(/\s+/g, ' '), source });
  // Alerts go out in the background so the customer (and the WhatsApp webhook) get an instant answer.
  setImmediate(async () => {
    let result; try { result = await sendOrderNotifications(order, s); } catch (e) { result = { ok: false, error: e.message }; }
    db.q('UPDATE orders SET notified = $1, notify_error = $2 WHERE code = $3', [result.ok ? 1 : 0, result.error || '', code]).catch(e => console.error('[orders] could not save alert result', e.message));
  });
  // SMS to the number set in Admin → Settings, the moment the buyer confirms.
  if (sms.enabled(s)) setImmediate(async () => {
    const r = await sms.send(s, sms.orderText(order, s));
    if (!r.ok) console.warn(`[sms] ${code}: ${r.error}`);
    db.q('UPDATE orders SET sms_status = $1 WHERE code = $2', [r.ok ? 'sent' : `failed: ${r.error}`, code]).catch(e => console.error('[orders] could not save SMS result', e.message));
  });
  return order;
}

// ---------- auth ----------
function sign(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex'); }
function makeToken() { const exp = Date.now() + 7 * 24 * 3600 * 1000; return `${exp}.${sign(exp)}`; }
function validToken(t) {
  if (!t || !ADMIN_PASSWORD) return false; const [exp, sig] = String(t).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp)); return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m && decodeURIComponent(m[1]); }
const requireAdmin = (req, res, next) => validToken(cookie(req, 'gf_admin') || (req.headers.authorization || '').replace(/^Bearer /, ''))
  ? next() : res.status(401).json({ error: 'Please log in.' });
function requireBot(req, res, next) {
  const k = req.headers['x-api-key'] || '';
  if (!BOT_API_KEY) return res.status(503).json({ error: 'Bot API is disabled. Set BOT_API_KEY.' });
  const a = Buffer.from(String(k)), b = Buffer.from(BOT_API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? next() : res.status(401).json({ error: 'Invalid API key.' });
}

// ---------- app ----------
const app = express();
// Behind one HTTPS proxy (nginx, Caddy, Railway, Render…) by default. Set TRUST_PROXY=0 if the app is reached directly, or to the number of proxies in front.
app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY || '') ? Number(process.env.TRUST_PROXY) : 1);
app.use(publicUrls.middleware);
if (DEMO) require('./dev/demo')(app, { dataDir: DATA_DIR, key: process.env.LEADSINTEL_PLATFORM_KEY, getSettings });
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/healthz', async (req, res) => { try { await db.one('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });

// ---------- WhatsApp via LeadsIntel: inbound webhook ----------
// LeadsIntel POSTs each incoming WhatsApp event here, signed with the connection's inboundWebhookSecret.
// We answer with HTTP 200 + reply JSON, which LeadsIntel sends back to the customer.
const chat = createChat({ db, getSettings, visibleItems: () => publicMenu().items, priceCart, createOrder: (b, src) => createOrder(b, src), money: (n, s) => money(n, s), safeJSON, trackUrl,
  // The kitchen hears about a customer cancelling, or asking for a person, the same way it hears about new orders.
  onOrderCancelled: row => { const s = getSettings(); const msg = `❌ Order ${row.code} was CANCELLED by the customer (${row.customer_name}, +${row.phone}).`;
    sendKitchen(s, msg, `order-${row.code}-cancelled`).catch(() => {});
    if (sms.enabled(s)) sms.send(s, `${s.business_name}: order ${row.code} was CANCELLED by the customer (${row.customer_name}, 0${String(row.phone).slice(3)}).`).catch(() => {}); },
  onAgentRequest: (phone, name) => { const s = getSettings();
    sendKitchen(s, `🙋 A customer wants to talk to a person: ${name ? name + ', ' : ''}+${phone}\nhttps://wa.me/${phone}`, `agent-${phone}-${Math.floor(Date.now() / 600000)}`).catch(() => {}); },
});
app.post('/webhooks/leadsintel', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const v = li.verify(raw, req.headers);
  if (!v.ok) { console.warn('[webhook] rejected:', v.reason); return res.status(401).json({ error: v.reason }); }
  let body; try { body = JSON.parse(raw); } catch { return res.status(400).json({ error: 'invalid json' }); }
  const want = li.cfg().phoneNumberId; const got = body && body.metadata && body.metadata.phone_number_id;
  if (want && got && String(got) !== String(want)) return res.status(400).json({ error: 'unknown phone_number_id' });
  const eventId = String(req.headers['x-leadintel-event-id'] || '');
  try {
    // Save the event id before doing any work (LeadsIntel retries, and may deliver the same event twice at once).
    if (eventId && !(await db.q('INSERT INTO webhook_events (id, at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id', [eventId, Date.now()])).length) return res.status(204).end();
    const replies = [];
    for (const m of (Array.isArray(body.messages) ? body.messages : []).slice(0, 5)) {
      const input = chat.parseMessage(m); if (!input) continue;
      const phone = normPhone(m.from);
      touchCustomer(phone, { source: 'whatsapp' });
      replies.push(getSettings().whatsapp_chat_enabled !== '1' ? 'WhatsApp ordering is currently unavailable. Please order on our website.' : input.unsupported ? 'Please send a text message here. Voice notes are supported in our website chat.' : await customerChat.handleWhatsApp(phone, input, m.id || eventId));
    }
    db.q('DELETE FROM webhook_events WHERE at < $1', [Date.now() - 3 * 24 * 3600 * 1000]).catch(() => {});
    if (!replies.length) return res.status(204).end();
    res.status(200).json({ type: 'text', text: replies.join('\n\n').replace(/\/t\/([A-Za-z0-9_-]+)/g, (_, token) => trackUrl(token)).slice(0, 4000) });
  } catch (e) {
    console.error('[webhook] error', e);
    if (eventId) await db.q('DELETE FROM webhook_events WHERE id = $1', [eventId]).catch(() => {}); // let the retry through
    res.status(500).json({ error: 'temporary error' });
  }
});

app.use(express.json({ limit: '200kb' }));
app.use('/uploads', photoStorage.servePhotos(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Messages thrown by our own checks go to the user as-is. Database and system faults (they carry a `code`) are logged and hidden.
const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => {
  if (e.code) { console.error(`[error] ${req.method} ${req.path}:`, e.message); return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' }); }
  res.status(e.status || 400).json({ error: e.message || 'Something went wrong.' });
});

function publicMenu() {
  const s = getSettings();
  const items = ITEMS.filter(r => r.available).map(rowToItem);
  return { business_name: s.business_name, tagline: s.tagline, currency: s.currency, delivery_fee: Number(s.delivery_fee) || 0,
    accepting_orders: s.accepting_orders === '1', closed_message: s.closed_message, delivery_times: safeJSON(s.delivery_times, []),
    website_chat_enabled: s.website_chat_enabled === '1', whatsapp_chat_enabled: s.whatsapp_chat_enabled === '1',
    payment_note: s.payment_note, items };
}
function menuText(m) {
  if (!m.items.length) return 'No items on the menu right now.';
  return m.items.map((it, i) => {
    let t = `${i + 1}. ${it.name} — ${m.currency} ${it.price}${it.unit ? ' / ' + it.unit : ''}` + (it.description ? `\n   ${it.description}` : '');
    for (const g of it.options) t += `\n   ${g.name}${g.required ? ' (required)' : ''}: ` + g.choices.map(c => c.label + (c.price ? ` (+${m.currency} ${c.price})` : '')).join(', ');
    return t;
  }).join('\n\n') + (m.delivery_fee ? `\n\nDelivery: ${m.currency} ${m.delivery_fee}` : '');
}

// Public
// Customer-facing WhatsApp always uses the number selected by the admin.
function whatsappUrl() {
  if (getSettings().whatsapp_chat_enabled !== '1') return '';
  const d = String(waGet().display_phone || '').replace(/\D/g, '');
  return li.sendConfigured() && /^\d{9,15}$/.test(d) ? `https://wa.me/${d}?text=MENU` : '';
}
app.get('/api/menu', (req, res) => res.json({ ...publicMenu(), whatsapp_url: whatsappUrl(), whatsapp_demo: DEMO }));
const customerChat = require('./web-chat')(app, { db, publicMenu, whatsappUrl, priceCart, createOrder, rowToOrder, normPhone, validPhone, rateLimited, wrap,
  notifyCancelled: async row => {
    const s = getSettings(), message = `Order ${row.code} was CANCELLED by the customer.`;
    await sendKitchen(s, message, `order-${row.code}-cancelled`).catch(() => {});
    if (sms.enabled(s)) await sms.send(s, message).catch(() => {});
  },
  requestAgent: async (phone, name) => {
    if (DEMO) return false;
    const r = await sendKitchen(getSettings(), `A customer requests a callback: ${name || 'Customer'}, +${phone}`, `agent-${phone}-${Math.floor(Date.now() / 600000)}`);
    return !!r.ok;
  }
});
app.post('/api/orders', wrap(async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many orders from this device. Please WhatsApp us instead.' });
  const o = await createOrder(req.body || {}, 'web');
  res.status(201).json({ code: o.code, total: o.total, items: o.items, delivery_fee: o.delivery_fee, subtotal: o.subtotal, track_url: o.track_url, has_pin: o.lat != null });
}));

// WhatsApp bot (LeadsIntel) — authenticate with header  X-API-Key: <BOT_API_KEY>
app.get('/api/bot/menu', requireBot, (req, res) => { const m = publicMenu(); res.json({ ...m, menu_text: menuText(m) }); });
app.post('/api/bot/quote', requireBot, wrap(async (req, res) => res.json(priceCart((req.body || {}).items))));
app.post('/api/bot/orders', requireBot, wrap(async (req, res) => {
  const o = await createOrder(req.body || {}, 'whatsapp');
  res.status(201).json({ ...o, confirmation_text: `Thank you ${o.customer_name}! Your order ${o.code} is received. Total: ${getSettings().currency} ${o.total}. We'll deliver to ${o.location}${o.delivery_date ? ' on ' + o.delivery_date : ''}${o.delivery_time ? ', ' + o.delivery_time : ''}.` });
}));
app.get('/api/bot/orders/:code', requireBot, wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM orders WHERE code = $1', [String(req.params.code).toUpperCase()]);
  r ? res.json(rowToOrder(r)) : res.status(404).json({ error: 'Order not found.' });
}));

// Admin
app.post('/api/admin/login', (req, res) => {
  const fails = hits(loginFails, req.ip);
  if (fails.length >= 8) return res.status(429).json({ error: 'Too many wrong passwords. Please wait 10 minutes and try again.' });
  const p = String((req.body || {}).password || '');
  const a = Buffer.from(p), b = Buffer.from(ADMIN_PASSWORD);
  if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) { fails.push(Date.now()); loginFails.set(req.ip, fails); return res.status(401).json({ error: 'Wrong password.' }); }
  loginFails.delete(req.ip);
  const t = makeToken();
  res.setHeader('Set-Cookie', `gf_admin=${encodeURIComponent(t)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.setHeader('Set-Cookie', 'gf_admin=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/items', requireAdmin, (req, res) => res.json(ITEMS.map(rowToAdminItem)));
const photos = require('./photo-library').photoLibrary(UPLOAD_DIR, db, {
  storage: photoStorage,
  sharedSchemas: true,
  legacyDirectories: [path.join(__dirname, 'data', 'uploads'), path.join(__dirname, 'data-demo', 'uploads')],
});
app.get('/api/admin/photos', requireAdmin, wrap(async (req, res) => res.json(await photos.list())));
app.delete('/api/admin/photos/:filename', requireAdmin, wrap(async (req, res) => {
  try { res.json(await photos.remove(req.params.filename, req.body?.confirm)); }
  catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Photo could not be deleted. Try again.' }); }
}));
const ITEM_COLS = ['name', 'description', 'price', 'category', 'image', 'available', 'sort', 'options_json', 'prep', 'cooked_extra', 'unit', 'serves', 'min_qty', 'discount_type', 'discount_value', 'images_json'];
function itemFields(b, current) {
  const name = str(b.name, 120); if (!name) throw new Error('Name is required.');
  const price = Math.round(Number(b.price)); if (!Number.isSafeInteger(price) || price < 0 || price > 2147483647) throw new Error('Price must be a valid amount.');
  const discount = require('./discounts').validateDiscount(price, b.discount_type, b.discount_value);
  return { name, description: str(b.description, 600), price, ...discount, category: str(b.category, 60) || 'Menu', ...require('./item-images').imageFields(b, current),
    available: b.available === false ? 0 : 1, sort: Math.round(Number(b.sort) || 0),
    options_json: JSON.stringify(cleanOptions(b.options).filter(g => g.name.toLowerCase() !== PREP_QUESTION.toLowerCase())),
    prep: ['cooked', 'raw', 'both'].includes(b.prep) ? b.prep : '', cooked_extra: Math.max(0, Math.round(Number(b.cooked_extra) || 0)),
    unit: str(b.unit, 20).toLowerCase(), serves: Math.min(500, Math.max(0, Math.round(Number(b.serves) || 0))), min_qty: Math.min(50, Math.max(1, Math.round(Number(b.min_qty) || 1))) };
}
app.post('/api/admin/items', requireAdmin, wrap(async (req, res) => {
  const f = itemFields(req.body || {});
  const r = await photos.withItemsLock(async tx => {
    await photos.assertImages(f);
    return tx.one(`INSERT INTO items (${ITEM_COLS.join(',')}) VALUES (${ITEM_COLS.map((c, i) => '$' + (i + 1)).join(',')}) RETURNING *`, ITEM_COLS.map(c => f[c]));
  });
  await loadItems();
  res.status(201).json(rowToAdminItem(r));
}));
app.put('/api/admin/items/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id), current = ITEMS.find(i => i.id === id);
  const f = itemFields({ discount_type: current?.discount_type, discount_value: current?.discount_value, ...(req.body || {}) }, current);
  const r = Number.isInteger(id) && await photos.withItemsLock(async tx => {
    await photos.assertImages(f);
    return tx.one(`UPDATE items SET ${ITEM_COLS.map((c, i) => `${c}=$${i + 1}`).join(', ')} WHERE id=$${ITEM_COLS.length + 1} RETURNING *`, [...ITEM_COLS.map(c => f[c]), id]);
  });
  if (!r) return res.status(404).json({ error: 'Item not found.' });
  await loadItems();
  res.json(rowToAdminItem(r));
}));
app.delete('/api/admin/items/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id); if (Number.isInteger(id)) { await db.q('DELETE FROM items WHERE id = $1', [id]); await loadItems(); }
  res.json({ ok: true });
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, f, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(f.mimetype)),
});
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.single('image')(req, res, async err => {
    if (err || !req.file) return res.status(400).json({ error: err?.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 6 MB.' : 'Please choose a JPG, PNG or WebP image under 6 MB.' });
    const filename = crypto.randomUUID() + '-optimized.webp';
    let output;
    try {
      // Decode real image bytes, correct phone orientation, strip metadata and
      // keep galleries small enough to load quickly on mobile connections.
      output = await require('sharp')(req.file.buffer, { limitInputPixels: 40000000 })
        .rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88 }).toBuffer();
    } catch {
      return res.status(400).json({ error: 'That photo could not be read. Choose a valid JPG, PNG or WebP image up to 40 megapixels.' });
    }
    try {
      await photoStorage.savePhoto(filename, output);
      res.json({ url: '/uploads/' + filename });
    } catch (error) {
      console.error('[photos] Storage write failed:', error.code || error.name);
      res.status(503).json({ error: 'Photo storage is temporarily unavailable. Please try uploading again.' });
    }
  });
});

app.get('/api/admin/orders', requireAdmin, wrap(async (req, res) => {
  if ('page' in req.query) {
    const requested = Number(req.query.page), size = Number(req.query.page_size || 10), st = String(req.query.status || '');
    const customer = req.query.customer_phone ? normPhone(String(req.query.customer_phone)) : '';
    if (req.query.customer_phone && !validPhone(customer)) return res.status(400).json({ error: 'Invalid customer phone number.' });
    if (!Number.isSafeInteger(requested) || requested < 1 || ![10,20,50].includes(size) || (st && !STATUSES.includes(st))) return res.status(400).json({ error: 'Invalid pagination or status filter.' });
    const result = await db.transaction(async tx => {
      await tx.q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const { total } = await tx.one("SELECT count(*) AS total FROM orders WHERE ($1::text='' OR status=$1) AND ($2::text='' OR phone=$2)", [st, customer]);
      const pages = Math.max(1, Math.ceil(total / size)), page = Math.min(requested, pages);
      const rows = await tx.q("SELECT * FROM orders WHERE ($1::text='' OR status=$1) AND ($2::text='' OR phone=$2) ORDER BY id DESC LIMIT $3 OFFSET $4", [st, customer, size, (page - 1) * size]);
      const counts = await tx.one("SELECT count(*) AS new_count, COALESCE(max(id),0) AS latest_new_id FROM orders WHERE status='new'");
      return { orders: rowToOrderList(rows, getSettings()), page, page_size: size, total: Number(total), pages, new_count: Number(counts.new_count), latest_new_id: Number(counts.latest_new_id) };
    });
    return res.json(result);
  }
  const st = String(req.query.status || ''); const rows = STATUSES.includes(st)
    ? await db.q('SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 300', [st])
    : await db.q('SELECT * FROM orders ORDER BY id DESC LIMIT 300');
  const s = getSettings(); res.json(rowToOrderList(rows, s));
}));
function rowToOrderList(rows, s) { return rows.map(r => { const o = rowToOrder(r); o.kitchen_link = kitchenWaLink(o, s); return o; }); }
app.patch('/api/admin/orders/:code', requireAdmin, wrap(async (req, res) => {
  const st = String((req.body || {}).status || ''); if (!STATUSES.includes(st)) throw new Error('Unknown status.');
  const r = await db.transaction(async tx => {
    const o = await tx.one('SELECT * FROM orders WHERE code=$1 FOR UPDATE', [req.params.code]);
    if (o && st === 'cancelled' && require('./sunpay').ACTIVE.includes(o.payment_status)) throw new Error('Resolve the payment with SunPay before cancelling this order. Payments are not automatically refunded.');
    return tx.q(`UPDATE orders SET status=$1, updated_at=now(),
      delivered_at=CASE WHEN $1='delivered' THEN COALESCE(delivered_at,now()) ELSE NULL END
      WHERE code=$2 RETURNING id`, [st, req.params.code]);
  });
  r.length ? res.json({ ok: true }) : res.status(404).json({ error: 'Order not found.' });
}));
// Edit an order. Lines sent as { keep: <position in the saved order>, qty, note } keep their original price (even if the
// menu changed since); lines sent as { item_id, qty, options, note } are new and are priced from today's menu.
app.put('/api/admin/orders/:code', requireAdmin, wrap(async (req, res) => {
  const result = await db.transaction(async tx => {
  const cur = await tx.one('SELECT * FROM orders WHERE code = $1 FOR UPDATE', [req.params.code]); if (!cur) throw new Error('Order not found.');
  if (require('./sunpay').ACTIVE.includes(cur.payment_status)) throw new Error('This order has a pending or completed payment and cannot be edited. Resolve the payment first.');
  const b = req.body || {}; const old = safeJSON(cur.items_json, []);
  const name = str(b.customer_name, 80), phone = normPhone(b.phone), location = str(b.location, 300);
  if (!name) throw new Error('The customer name is required.');
  if (!validPhone(phone)) throw new Error('Please add a valid Kenyan phone number, e.g. 0712 345 678.');
  if (!location) throw new Error('The delivery location is required.');
  if (!Array.isArray(b.items) || !b.items.length) throw new Error('An order needs at least one item. To drop the whole order, set its status to Cancelled.');
  if (b.items.length > 30) throw new Error('Too many lines in one order.');
  const lines = b.items.map(l => {
    if (l && Number.isInteger(l.keep)) {
      const o = old[l.keep]; if (!o) throw new Error('That order changed in the meantime. Close the editor and open it again.');
      const qty = Math.round(Number(l.qty)); if (!(qty >= 1 && qty <= 50)) throw new Error(`Quantity for ${o.name} must be between 1 and 50.`);
      return { ...o, qty, line_total: o.unit_price * qty, note: str(l.note ?? o.note, 200) };
    }
    return priceCart([l || {}], { allowHidden: true }).lines[0];
  });
  const subtotal = lines.reduce((n, l) => n + l.line_total, 0);
  const fee = 'delivery_fee' in b ? Math.round(Number(b.delivery_fee)) : cur.delivery_fee;
  if (!(fee >= 0 && fee <= 100000)) throw new Error('The delivery fee must be zero or more.');
  const row = await tx.one(`UPDATE orders SET customer_name = $1, phone = $2, location = $3, delivery_date = $4, delivery_time = $5, notes = $6,
      items_json = $7, subtotal = $8, delivery_fee = $9, total = $10, updated_at = now() WHERE code = $11 RETURNING *`,
    [name, phone, location, str(b.delivery_date, 20), str(b.delivery_time, 60), str(b.notes, 500), JSON.stringify(lines), subtotal, fee, subtotal + fee, cur.code]);
  touchCustomer(phone, { name, source: cur.source });
  return row;
  });
  res.json(rowToOrderList([result], getSettings())[0]);
}));
app.post('/api/admin/orders/:code/renotify', requireAdmin, wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM orders WHERE code = $1', [req.params.code]); if (!r) return res.status(404).json({ error: 'Order not found.' });
  const result = await sendOrderNotifications(rowToOrder(r), getSettings(), { kitchenOnly: true, attempt: Date.now() });
  await db.q('UPDATE orders SET notified = $1, notify_error = $2 WHERE code = $3', [result.ok ? 1 : 0, result.error || '', r.code]);
  res.json(result);
}));

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const credentials = require('./credentials');
app.get('/api/admin/provider-keys', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ai_provider: getSettings().ai_provider || 'gemini', openai: credentials.status('openai'), gemini: credentials.status('gemini'), leadsintel: credentials.status('leadsintel'), sunpay: credentials.status('sunpay'), demo: DEMO });
});
app.put('/api/admin/provider-keys/:provider', requireAdmin, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.get('sec-fetch-site') === 'cross-site' || !req.is('application/json')) return res.status(403).json({ error: 'Use Admin Settings to change keys.' });
  if (!['gemini', 'openai', 'leadsintel', 'sunpay'].includes(req.params.provider)) return res.status(400).json({ error: 'Unknown provider.' });
  const body = req.body || {};
  res.json(await credentials.update(req.params.provider, body.key, body.remove === true));
}));
// What the admin page gets: everything except the SMS key itself (only whether one is saved, and its last 4 characters).
function adminSettings() {
  const { sms_api_key: key, ...s } = getSettings();
  return { ...s, sms_api_key_set: !!key, sms_api_key_hint: key ? '••••' + key.slice(-4) : '', notify_configured: li.sendConfigured(), inbound_configured: li.inboundConfigured() };
}
app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(adminSettings()));
app.put('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {}; const changes = [];
  for (const k of SETTING_KEYS) if (k in b) {
    let v = b[k];
    if (k === 'ai_provider' && !['gemini', 'openai'].includes(v)) throw new Error('Choose Gemini or OpenAI.');
    if (k === 'notify_phone') { // one or more kitchen phones, separated by commas or new lines
      const list = [...new Set(String(v || '').split(/[,\n;]+/).map(x => x.trim()).filter(Boolean).map(normPhone))];
      if (!list.length || list.some(x => !validPhone(x))) throw new Error('Each kitchen phone must be a valid Kenyan number, e.g. 0712 345 678. Use commas for more than one.');
      if (list.length > 5) throw new Error('At most 5 kitchen phones.');
      if (list.includes(String(waGet().display_phone || '').replace(/\D/g, ''))) throw new Error('A kitchen phone must be different from the WhatsApp ordering number (WhatsApp can’t message itself).');
      v = list.join(','); }
    if (k === 'delivery_times') v = JSON.stringify((Array.isArray(v) ? v : String(v).split('\n')).map(x => str(x, 60)).filter(Boolean).slice(0, 12));
    if (['accepting_orders', 'notify_customer', 'sms_enabled', 'website_chat_enabled', 'whatsapp_chat_enabled'].includes(k)) v = v === true || v === '1' ? '1' : '0';
    if (k === 'sms_api_key') { v = str(v, 200); if (!v) continue; } // left blank = keep the saved key
    if (k === 'sms_sender_id') { v = str(v, 20); if (v && !/^[A-Za-z0-9 _.-]{2,20}$/.test(v)) throw new Error('The SMS sender ID should be the short name or number Blessed Texts gave you.'); }
    if (k === 'sms_phone') { const list = String(v || '').split(/[,\n]+/).map(x => x.trim()).filter(Boolean).map(normPhone);
      if (list.some(x => !validPhone(x))) throw new Error('SMS number must be a valid Kenyan number (use commas for more than one).'); if (list.length > 5) throw new Error('At most 5 SMS numbers.'); v = list.join(','); }
    if (k === 'delivery_fee') v = String(Math.max(0, Math.round(Number(v) || 0)));
    changes.push([k, typeof v === 'string' ? v.slice(0, 600) : String(v)]);
  }
  for (const c of changes) await db.q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', c);
  await loadSettings();
  const now = getSettings();
  if (now.sms_enabled === '1' && !sms.configured(now)) { await db.q("UPDATE settings SET value = '0' WHERE key = 'sms_enabled'"); await loadSettings(); throw new Error('Saved, but SMS alerts stay off until both the API key and the sender ID are filled in.'); }
  res.json(adminSettings());
}));
app.post('/api/admin/test-notify', requireAdmin, wrap(async (req, res) => {
  const s = getSettings(); res.json(await sendKitchen(s, `✅ ${s.business_name} test: order notifications are working.`, 'test-' + Date.now()));
}));
app.post('/api/admin/test-sms', requireAdmin, wrap(async (req, res) => {
  const s = getSettings(); res.json(await sms.send(s, `${s.business_name} test: SMS order alerts are working.`));
}));

// ---------- customers ----------
app.get('/api/admin/customers', requireAdmin, wrap(async (req, res) => {
  const rows = await db.q(`SELECT c.phone, c.name, c.username, c.source, c.created_at, c.last_seen_at,
      COUNT(o.id)::int AS orders, COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS spent, MAX(o.created_at) AS last_order_at
    FROM customers c LEFT JOIN orders o ON o.phone = c.phone GROUP BY c.phone ORDER BY c.last_seen_at DESC LIMIT 2000`);
  res.json(rows.map(r => ({ ...r, name: r.name || '', username: r.username || '', created_at: stamp(r.created_at), last_seen_at: stamp(r.last_seen_at), last_order_at: stamp(r.last_order_at) })));
}));

// ---------- poster QR codes ----------
const siteUrl = () => publicUrls.requireOrigin();
app.get('/api/admin/poster', requireAdmin, (req, res) => {
  const w = whatsappUrl(); const s = getSettings();
  res.json({ site_url: siteUrl(req) + '/', whatsapp_ready: !!w, whatsapp_phone: waGet().display_phone || '', business_name: s.business_name, tagline: s.tagline });
});
app.get('/api/admin/qr.svg', requireAdmin, wrap(async (req, res) => {
  const w = whatsappUrl();
  const url = req.query.to === 'whatsapp' ? (w.startsWith('/') ? siteUrl(req) + w : w) : siteUrl(req) + '/';
  if (!url) return res.status(404).json({ error: 'Link a WhatsApp number first (Settings).' });
  res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#143D27', light: '#FFFFFF' } }));
}));

// PNG / PDF / SVG poster exports (one renderer, see poster-renderer.js)
require('./poster-renderer').routes(app, { requireAdmin, wrap, getSettings, whatsappUrl, siteUrl });

// ---------- WhatsApp number (LeadsIntel) ----------
// Two ways to choose the number customers chat with:
//   1. Use a number already connected on LeadsIntel  → lookup by phone, then point its webhook here.
//   2. Connect a new number                           → LeadsIntel assisted setup; we poll until it is connected.
const webhookUrl = () => publicUrls.origin() ? publicUrls.absolute('/webhooks/leadsintel') : '';
const needKey = () => { if (!li.keyConfigured()) throw new Error('Add the LeadsIntel API key in Admin Settings first.'); };
const needHttps = () => { if (!/^https:\/\//.test(webhookUrl())) throw new Error('Open Admin using the hosted HTTPS website address so LeadsIntel can reach the webhook.'); };
const ACTIVE = ['connected', 'active'];
function parseNumber(b) {
  const cc = String(b.country_code || '254').replace(/\D/g, '') || '254';
  let d = String(b.phone || '').replace(/\D/g, '');
  if (d.startsWith(cc) && d.length > cc.length + 6) d = d.slice(cc.length);
  d = d.replace(/^0+/, '');
  if (d.length < 6 || cc.length + d.length > 15) throw new Error('Enter a valid phone number.');
  return { cc, national: d, e164: `+${cc}${d}` };
}
const LOOKUP_ERRORS = { 404: 'That number is not connected on LeadsIntel yet. Use “Connect a new number” instead.',
  409: 'LeadsIntel has more than one connection for that number. Ask LeadsIntel which one to use.', 400: 'LeadsIntel says that phone number is not valid.' };

async function refreshWa() {
  let L = waGet();
  if (!li.keyConfigured()) return L;
  // A failed request is still checked: LeadsIntel can restart it on their side, and the same number can't be submitted twice.
  if (L.mode === 'new' && L.request_id && !['connected', 'cancelled'].includes(L.request_status)) {
    const r = await li.getAssisted(L.request_id);
    if (r.ok && r.data) {
      await waSet({ request_status: r.data.status || L.request_status, request_error: [r.data.errorCode, r.data.errorMessage].filter(Boolean).join(': '),
        display_phone: r.data.displayPhoneNumber || L.display_phone,
        tenant_id: r.data.externalPlatformTenantId || L.tenant_id, connection_id: r.data.externalConnectionId || L.connection_id });
      L = waGet();
    }
  }
  return L;
}

app.get('/api/admin/whatsapp', requireAdmin, wrap(async (req, res) => {
  const L = await refreshWa();
  const out = { demo: DEMO, key_configured: li.keyConfigured(), webhook_url: webhookUrl(), https: /^https:\/\//.test(webhookUrl()),
    mode: L.mode || '', display_phone: L.display_phone || '', ready: li.sendConfigured(),
    request: L.mode === 'new' ? { status: L.request_status, error: L.request_error || '' } : null, connection: null };
  // WhatsApp cannot deliver a message a number sends to itself, so the kitchen phone must be a different phone.
  out.same_as_kitchen = !!L.display_phone && kitchenPhones(getSettings()).includes(String(L.display_phone).replace(/\D/g, ''));
  if (li.sendConfigured()) {
    const r = await li.getConnection();
    if (r.ok && r.data) {
      out.connection = { status: r.data.status || '', display_phone: r.data.displayPhoneNumber || '', webhook: r.data.inboundWebhookUrl || '' };
      out.pointed = !!out.webhook_url && out.connection.webhook === out.webhook_url;
      out.active = ACTIVE.includes(String(out.connection.status).toLowerCase()); // LeadsIntel only sends through an active connection
      if (r.data.phoneNumberId && r.data.phoneNumberId !== L.phone_number_id) await waSet({ phone_number_id: r.data.phoneNumberId });
      if (r.data.displayPhoneNumber && r.data.displayPhoneNumber !== L.display_phone) { await waSet({ display_phone: r.data.displayPhoneNumber }); out.display_phone = r.data.displayPhoneNumber; }
    } else out.connection_error = li.errText(r);
  }
  res.json(out);
}));

// Step 1 of "use existing": show the admin which connection was found before switching it.
app.post('/api/admin/whatsapp/lookup', requireAdmin, wrap(async (req, res) => {
  needKey(); const n = parseNumber(req.body || {});
  const r = await li.lookup(n.e164);
  if (!r.ok) throw new Error(LOOKUP_ERRORS[r.status] || li.errText(r));
  res.json({ display_phone: r.data.displayPhoneNumber || n.e164, status: r.data.status || '', disconnected: !!r.data.disconnectedAt });
}));

app.post('/api/admin/whatsapp/use-existing', requireAdmin, wrap(async (req, res) => {
  needKey(); needHttps(); const n = parseNumber(req.body || {});
  const cur = waGet();
  if (cur.mode === 'new' && !['connected', 'failed', 'cancelled'].includes(cur.request_status)) throw new Error('A new-number setup is still in progress. Cancel it first.');
  const r = await li.lookup(n.e164);
  if (!r.ok) throw new Error(LOOKUP_ERRORS[r.status] || li.errText(r));
  const c = r.data; if (c.disconnectedAt) throw new Error('That number is disconnected on LeadsIntel. Reconnect it there first.');
  const secret = li.newSecret();
  const p = await li.patchConnection(c.externalPlatformTenantId, c.externalConnectionId, { inboundWebhookUrl: webhookUrl(), inboundWebhookSecret: secret });
  if (!p.ok) throw new Error(p.status === 409 ? 'That connection is not active on LeadsIntel yet.' : li.errText(p));
  await waClear();
  await waSet({ mode: 'existing', tenant_id: c.externalPlatformTenantId, connection_id: c.externalConnectionId, phone_number_id: c.phoneNumberId || '',
    display_phone: c.displayPhoneNumber || n.e164, webhook_secret: secret });
  res.json({ ok: true });
}));

app.post('/api/admin/whatsapp/connect-new', requireAdmin, wrap(async (req, res) => {
  needKey(); needHttps(); const b = req.body || {}; const n = parseNumber(b);
  const cur = waGet();
  if (cur.mode === 'new' && !['failed', 'cancelled'].includes(cur.request_status)) throw new Error('A new-number setup already exists. Cancel or unlink it first.');
  const businessName = str(b.business_name, 120), displayName = str(b.display_name, 120);
  if (!businessName || !displayName) throw new Error('Business name and WhatsApp display name are required.');
  const email = str(b.email, 120); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Email does not look right.');
  const website = str(b.website, 200); if (website && !/^https?:\/\//.test(website)) throw new Error('Website must start with https://');
  const profile = Object.fromEntries(Object.entries({ about: str(b.about, 139), description: str(b.description, 512), address: str(b.address, 256),
    email, websites: website ? [website] : undefined }).filter(([, v]) => v && (!Array.isArray(v) || v.length)));
  const tenant = process.env.LEADSINTEL_TENANT_ID || 'grinfud';
  const conn = `grinfud-${n.cc}${n.national}`;
  const secret = li.newSecret();
  const r = await li.createAssisted({ externalPlatformTenantId: tenant, externalConnectionId: conn, countryCode: n.cc, phoneNumber: n.national,
    businessName, displayName, ...(Object.keys(profile).length ? { businessProfile: profile } : {}),
    inboundWebhookUrl: webhookUrl(), inboundWebhookSecret: secret });
  if (!r.ok) {
    if (r.status === 409) throw new Error('This number is already on LeadsIntel, or had an earlier setup request. Use “Use a number already on LeadsIntel”, or ask LeadsIntel to retry the earlier request.');
    throw new Error(li.errText(r));
  }
  await waClear();
  await waSet({ mode: 'new', tenant_id: tenant, connection_id: conn, display_phone: n.e164, webhook_secret: secret,
    request_id: r.data && r.data.requestId, request_status: (r.data && r.data.status) || 'pending', request_error: '' });
  res.json({ ok: true, status: 'pending' });
}));

app.post('/api/admin/whatsapp/cancel', requireAdmin, wrap(async (req, res) => {
  needKey(); const L = waGet();
  if (L.mode !== 'new' || L.request_status !== 'pending') throw new Error('Only a setup that is still pending can be cancelled.');
  const r = await li.cancelAssisted(L.request_id);
  if (!r.ok) throw new Error(li.errText(r));
  await waSet({ request_status: 'cancelled' }); res.json({ ok: true });
}));

// Re-send our webhook address + secret to LeadsIntel (if someone changed it there).
app.post('/api/admin/whatsapp/repoint', requireAdmin, wrap(async (req, res) => {
  needKey(); needHttps(); if (!li.sendConfigured()) throw new Error('No connected number yet.');
  const L = waGet(); const r = await li.patchConnection(L.tenant_id, L.connection_id, { inboundWebhookUrl: webhookUrl(), inboundWebhookSecret: L.webhook_secret });
  if (!r.ok) throw new Error(li.errText(r)); res.json({ ok: true });
}));

// Forget the number here only. Nothing is deleted on LeadsIntel or WhatsApp.
app.post('/api/admin/whatsapp/unlink', requireAdmin, wrap(async (req, res) => { await waClear(); res.json({ ok: true }); }));

// ---------- order tracking (public, by secret link) ----------
// Whoever holds the link sees that one order: what was ordered, where it is going and how far along it is. Nothing else.
const trackLimited = new Map();
app.get('/t/:token', (req, res) => { res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer'); res.sendFile(path.join(__dirname, 'public', 'track.html')); });
const trackedOrder = async token => (/^[\w-]{16,40}$/.test(String(token)) ? db.one('SELECT * FROM orders WHERE track_token = $1', [token]) : null);
const sunpay = require('./sunpay').routes(app, { db, requireAdmin, trackedOrder, getSettings });
require('./receipts').routes(app, { db, requireAdmin, trackedOrder, getSettings, wrap });
const PIN_OPEN = ['new', 'preparing', 'out_for_delivery'];
function trackView(r) {
  const o = rowToOrder(r), s = getSettings();
  return { code: o.code, status: o.status, first_name: String(o.customer_name || '').split(' ')[0], items: o.items.map(i => ({ qty: i.qty, name: i.name, options: i.options.map(x => x.choice), line_total: i.line_total })),
    subtotal: o.subtotal, delivery_fee: o.delivery_fee, total: o.total, delivery_date: o.delivery_date, delivery_time: o.delivery_time, location: o.location, map_link: o.map_link,
    can_pin: PIN_OPEN.includes(o.status), created_at: o.created_at, updated_at: o.updated_at, currency: s.currency, business_name: s.business_name, payment_note: s.payment_note,
    contact_phone: kitchenPhone(s), whatsapp_url: whatsappUrl(), receipt_types: o.receipt_types, payment_status: o.payment_status, payment_receipt: o.payment_receipt, delivered_at: o.delivered_at };
}
app.get('/api/track/:token', wrap(async (req, res) => {
  const r = await trackedOrder(req.params.token);
  r ? res.json(trackView(r)) : res.status(404).json({ error: 'We could not find that order. Check the link in your confirmation message.' });
}));
// The buyer drops (or moves) the delivery pin from the tracking page.
app.post('/api/track/:token/pin', wrap(async (req, res) => {
  const tries = hits(trackLimited, req.ip); tries.push(Date.now()); trackLimited.set(req.ip, tries);
  if (tries.length > 20) return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
  const pin = cleanPin((req.body || {}).lat, (req.body || {}).lng); if (!pin) throw new Error('That location could not be read. Please try again.');
  const r = await trackedOrder(req.params.token); if (!r) return res.status(404).json({ error: 'We could not find that order.' });
  if (!PIN_OPEN.includes(r.status)) throw new Error('This order is already closed, so the location can no longer be changed.');
  const row = await db.one('UPDATE orders SET lat = $1, lng = $2, updated_at = now() WHERE id = $3 RETURNING *', [pin.lat, pin.lng, r.id]);
  if (r.lat == null) { const s = getSettings(); sendKitchen(s, `📍 ${row.customer_name} added a delivery pin for order ${row.code}:\n${mapLink(row)}`, `order-${row.code}-pin`).catch(() => {}); }
  res.json(trackView(row));
}));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Anything that slipped past a route's own handling: log it, answer with JSON, never a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large' || err.type === 'entity.parse.failed' || err.name === 'MulterError') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(`[error] ${req.method} ${req.path}:`, err); res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

let server;
initDb().then(() => credentials.init(db)).then(() => sunpay.init()).then(async () => {
  if (process.argv.includes('--migrate-only')) {
    await db.close();
    console.log('Database initialization and additive migrations completed.');
    return;
  }
  server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`GrinFud Orders listening on port ${PORT}. Public links use the hosted request address.`);
    if (DEMO) console.log('\n  DEMO MODE — WhatsApp/SMS are simulated. SunPay payments are REAL if explicitly enabled.\n  Admin: /admin (password: demo)\n  Simulator: /simulator\n  Order page: /\n');
  });
}).catch(e => { console.error('✖ Could not start: ' + (e.message || e.code || e)); process.exit(1); });
// Finish in-flight requests and close the database cleanly when the host restarts the app.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  setTimeout(() => process.exit(0), 8000).unref();
  const done = () => db.close().catch(() => {}).then(() => process.exit(0));
  server ? server.close(done) : done();
});
