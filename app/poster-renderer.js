// One poster renderer for every export: SVG (preview), PNG (sharp, native preset pixels) and PDF (PDFKit + svg-to-pdfkit, vector).
// QR codes are true vector paths of the exact hosted links, with a 4-module quiet zone and error correction M.
// No URL text is printed under the codes, no sample products, no advertising claims.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const C = { forest: '#143D27', green: '#1F5C3A', gold: '#F2B33D', deepgold: '#B8760F', cream: '#FBF7EE', paper: '#FFFDF8', mint: '#CFE3D5', muted: '#55655B', white: '#FFFFFF' };
const MM = 72 / 25.4;
// safe: fractions of height kept clear of key content (platform UI overlays). side: fraction of width per side.
const PRESETS = {
  'wall-a5': { label: 'Wall poster A5 (print, 300 dpi)', w: 1748, h: 2480, kind: 'wall', dpi: 300, pdf: [148 * MM, 210 * MM], safe: [0.05, 0.05], side: 0.08 },
  'wall-a4': { label: 'Wall poster A4 (print, 300 dpi)', w: 2480, h: 3508, kind: 'wall', dpi: 300, pdf: [210 * MM, 297 * MM], safe: [0.05, 0.05], side: 0.08 },
  'whatsapp-status': { label: 'WhatsApp Status 1080×1920', w: 1080, h: 1920, kind: 'story', safe: [0.13, 0.17], side: 0.08 },
  'instagram-post': { label: 'Instagram post 1080×1350', w: 1080, h: 1350, kind: 'post', safe: [0.05, 0.05], side: 0.08 },
  'instagram-story': { label: 'Instagram Story 1080×1920', w: 1080, h: 1920, kind: 'story', safe: [0.13, 0.18], side: 0.08 },
  'facebook-post': { label: 'Facebook post 1200×630', w: 1200, h: 630, kind: 'wide', safe: [0.08, 0.08], side: 0.05 },
  tiktok: { label: 'TikTok 1080×1920', w: 1080, h: 1920, kind: 'story', safe: [0.12, 0.22], side: 0.12 },
  square: { label: 'Square 1080×1080 (WhatsApp / Facebook)', w: 1080, h: 1080, kind: 'post', safe: [0.05, 0.05], side: 0.08 },
};
const FORMATS = ['svg', 'png', 'pdf'];
const DEFAULT_HEADLINE = 'Scan to order';

const xml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const flag = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase()) ? true : ['0', 'false', 'off', 'no'].includes(String(v).toLowerCase()) ? false : (() => { throw bad('Channel toggles must be 1 or 0.'); })());

// Validates query/body input. Only enum presets/formats, a short plain headline and two booleans are accepted — never a URL.
function parseOptions(q = {}) {
  const preset = String(q.preset ?? 'wall-a4');
  if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) throw bad('Unknown poster size.');
  const format = String(q.format ?? 'svg');
  if (!FORMATS.includes(format)) throw bad('Format must be svg, png or pdf.');
  if (q.headline != null && typeof q.headline !== 'string') throw bad('Headline must be text.');
  const raw = (q.headline ?? '').replace(/\s+/g, ' ').trim();
  if ([...raw].length > 60) throw bad('Headline can be at most 60 characters.');
  if (/[\u0000-\u001F\u007F<>]/.test(raw)) throw bad('Headline cannot contain < or > or control characters.');
  return { preset, format, headline: raw || DEFAULT_HEADLINE, wa: flag(q.wa, true), site: flag(q.site, true) };
}

// WhatsApp only when asked for AND connected; the website is the fallback, so there is never zero QR codes.
function resolveChannels(opt, { whatsappUrl = '', siteUrl = '' }) {
  const out = [];
  if (opt.wa && whatsappUrl) out.push({ key: 'whatsapp', label: 'Order on WhatsApp', url: whatsappUrl });
  if ((opt.site || !out.length) && siteUrl) out.push({ key: 'site', label: 'Order online', url: siteUrl });
  if (!out.length) throw bad('Open Admin using the website’s hosted address to make QR codes.');
  return out;
}

let LOGO = null;
function logoInner() {
  if (LOGO != null) return LOGO;
  try { const s = fs.readFileSync(path.join(__dirname, 'public', 'logo.svg'), 'utf8'); LOGO = s.slice(s.indexOf('>', s.indexOf('<svg')) + 1, s.lastIndexOf('</svg>')); } catch { LOGO = ''; }
  return LOGO;
}

// Vector QR, pixel-aligned: module size is a whole number of pixels so PNG edges are razor sharp.
function qrMatrix(url) { const q = QRCode.create(url, { errorCorrectionLevel: 'M' }); return { size: q.modules.size, get: (x, y) => q.modules.get(y, x) }; }
function qrGroup(url, x, y, maxSide, dark = C.forest) {
  const m = qrMatrix(url), total = m.size + 8, mod = Math.max(1, Math.floor(maxSide / total)), side = mod * total;
  x = Math.round(x + (maxSide - side) / 2); y = Math.round(y + (maxSide - side) / 2);
  let d = '';
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) {
    if (!m.get(c, r)) continue; let run = 1; while (c + run < m.size && m.get(c + run, r)) run++;
    d += `M${x + (c + 4) * mod} ${y + (r + 4) * mod}h${run * mod}v${mod}h${-run * mod}z`; c += run - 1;
  }
  return { side, x, y, modules: m.size, svg: `<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${C.white}"/><path d="${d}" fill="${dark}" shape-rendering="crispEdges"/>` };
}

const FONT = `'Bricolage Grotesque','DM Sans','DejaVu Sans',sans-serif`;
const wrap = (text, fs, maxW, maxLines = 2) => {
  let size = fs;
  for (;;) {
    const per = Math.max(6, Math.floor(maxW / (size * 0.56))), lines = [];
    for (const w of text.split(' ')) { const l = lines[lines.length - 1]; if (l && (l + ' ' + w).length <= per) lines[lines.length - 1] = l + ' ' + w; else lines.push(w); }
    if ((lines.length <= maxLines && lines.every(l => l.length <= per)) || size < fs * 0.45) return { lines, size };
    size *= 0.9;
  }
};
const fitSize = (text, fs, maxW, k = 0.58) => Math.min(fs, maxW / Math.max(1, text.length * k));
const txt = (x, y, s, fill, body, weight = 800, anchor = 'middle', extra = '') => `<text x="${r(x)}" y="${r(y)}" font-family="${FONT}" font-size="${r(s)}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${extra}>${body}</text>`;
const r = n => Math.round(n * 10) / 10;
function nameBody(name, a, b) { return name === 'GrinFud' ? `<tspan fill="${a}">Grin</tspan><tspan fill="${b}">Fud</tspan>` : `<tspan fill="${a}">${xml(name)}</tspan>`; }

// Returns { svg, width, height, preset, channels }.
function renderSvg({ preset: id, headline = DEFAULT_HEADLINE, name = 'GrinFud', tagline = '', channels }) {
  const P = PRESETS[id]; if (!P) throw bad('Unknown poster size.');
  if (!Array.isArray(channels) || !channels.length) throw bad('At least one QR code is required.');
  name = String(name || 'GrinFud').slice(0, 60); tagline = String(tagline || '').slice(0, 90); headline = String(headline || DEFAULT_HEADLINE).slice(0, 60);
  const { w: W, h: H, kind } = P, social = kind !== 'wall';
  const ink = social ? C.cream : C.forest, accent = social ? C.gold : C.deepgold, soft = social ? C.mint : C.muted, head = social ? C.gold : C.green;
  const n = channels.length, out = [];
  out.push(`<rect width="${W}" height="${H}" fill="${social ? C.forest : C.cream}"/>`);
  if (social) out.push(`<circle cx="${r(W * 0.95)}" cy="${r(H * 0.04)}" r="${r(Math.min(W, H) * 0.32)}" fill="${C.green}"/><circle cx="${r(W * 0.04)}" cy="${r(H * 0.98)}" r="${r(Math.min(W, H) * 0.26)}" fill="${C.green}"/><circle cx="${r(W * 0.9)}" cy="${r(H * 0.1)}" r="${r(Math.min(W, H) * 0.05)}" fill="${C.gold}" opacity="0.9"/>`);
  else { const b = Math.round(W * 0.025); out.push(`<rect x="${b}" y="${b}" width="${W - 2 * b}" height="${H - 2 * b}" rx="${b}" fill="none" stroke="${C.green}" stroke-width="${Math.round(W * 0.006)}"/>`); }
  const logo = (x, y, s) => `${social ? `<circle cx="${r(x + s / 2)}" cy="${r(y + s / 2)}" r="${r(s * 0.53)}" fill="${C.cream}"/>` : ''}<g transform="translate(${r(x)},${r(y)}) scale(${(s / 200).toFixed(4)})">${logoInner()}</g>`;
  const card = (cx, y, q, ch) => { // QR card: cream/white plate + vector QR + label
    const pad = Math.round(q * 0.06), lab = Math.round(Math.max(q * 0.11, 18)), cw = q + pad * 2, chh = q + pad * 2 + lab * 1.6;
    const g = qrGroup(ch.url, cx - q / 2, y + pad, q);
    return `<rect x="${r(cx - cw / 2)}" y="${r(y)}" width="${r(cw)}" height="${r(chh)}" rx="${r(pad * 1.2)}" fill="${C.white}"${social ? '' : ` stroke="${C.green}" stroke-width="${r(Math.max(2, q * 0.008))}"`}/>${g.svg}`
      + txt(cx, y + pad + q + lab * 1.15, fitSize(ch.label, lab, cw * 0.86, 0.64), C.forest, xml(ch.label));
  };
  const cardH = q => q + Math.round(q * 0.06) * 2 + Math.round(Math.max(q * 0.11, 18)) * 1.6;
  const footer = `Point your phone camera at ${n > 1 ? 'a' : 'the'} code`;

  if (kind === 'wide') {
    const pad = W * P.side, top = H * P.safe[0], bot = H * P.safe[1], A = H - top - bot, leftW = W * 0.46 - pad;
    const qMax = Math.min(A - (cardH(100) - 100) * 1.0, (W - pad - W * 0.5 - 30 * (n - 1)) / n - 20);
    const q = Math.floor(Math.min(qMax, A / 1.3)), ch = cardH(q), cy = top + (A - ch) / 2, gap = 30;
    const rowW = n * (q + q * 0.12) + gap * (n - 1); let x0 = W - pad - rowW;
    channels.forEach(c => { const cw = q + q * 0.12; out.push(card(x0 + cw / 2, cy, q, c)); x0 += cw + gap; });
    const L = H * 0.13, x = pad; let y = top + A * 0.04;
    out.push(logo(x, y, L)); out.push(txt(x + L * 1.2, y + L * 0.74, fitSize(name, H * 0.085, leftW - L * 1.2), ink, nameBody(name, ink, accent), 800, 'start'));
    y += L + H * 0.07; if (tagline) { out.push(txt(x, y, fitSize(tagline, H * 0.042, leftW, 0.5), soft, xml(tagline), 500, 'start')); y += H * 0.05; }
    const hw = wrap(headline, H * 0.1, leftW, 3); y += hw.size * 0.9;
    hw.lines.forEach((l, i) => out.push(txt(x, y + i * hw.size * 1.05, hw.size, head, xml(l), 800, 'start')));
    out.push(txt(x, top + A - H * 0.01, H * 0.036, soft, xml(footer), 500, 'start'));
  } else {
    const padX = W * P.side, cW = W - 2 * padX, top = H * P.safe[0], bot = H * P.safe[1], A = H - top - bot, u = W / 1000;
    const wall = kind === 'wall', gapQ = 60 * u;
    const hw = wrap(headline, (wall ? 84 : 76) * u, cW, 2);
    const plan = stack => {
      const q0 = n === 1 ? W * (wall ? 0.6 : 0.52) : stack ? W * 0.5 : (cW - gapQ) / 2 / 1.12;
      const qBlock = stack && n > 1 ? cardH(q0) * n + gapQ * (n - 1) : cardH(q0);
      const parts = [ // [height, draw(y, s)]
        [110 * u, (y, s) => logo(W / 2 - 55 * u * s, y, 110 * u * s)], [20 * u],
        [74 * u, (y, s) => txt(W / 2, y + 62 * u * s, fitSize(name, 84 * u * s, cW), ink, nameBody(name, ink, accent))],
        ...(tagline ? [[12 * u], [40 * u, (y, s) => txt(W / 2, y + 30 * u * s, fitSize(tagline, 36 * u * s, cW, 0.5), soft, xml(tagline), 500)]] : []),
        [50 * u],
        [hw.lines.length * hw.size * 1.08, (y, s) => hw.lines.map((l, i) => txt(W / 2, y + hw.size * s * (0.86 + i * 1.08), hw.size * s, head, xml(l))).join('')],
        [48 * u],
        [qBlock, (y, s) => { const q = Math.floor(q0 * s), cw = q * 1.12;
          if (stack) return channels.map((c, i) => card(W / 2, y + i * (cardH(q) + gapQ * s), q, c)).join('');
          let x = W / 2 - (n * cw + gapQ * (n - 1)) / 2 + cw / 2; return channels.map(c => { const g = card(x, y, q, c); x += cw + gapQ; return g; }).join(''); }],
        [40 * u],
        [34 * u, (y, s) => txt(W / 2, y + 26 * u * s, 30 * u * s, soft, xml(footer), 500)],
      ];
      const T = parts.reduce((a, p) => a + p[0], 0), rowW = stack ? q0 * 1.12 : n * q0 * 1.12 + gapQ * (n - 1);
      const s = Math.min(wall ? 1.2 : 1.25, A / T, cW / rowW);
      return { parts, T, s, q: q0 * s };
    };
    const a = plan(false), b = n > 1 ? plan(true) : a, best = b.q > a.q * 1.08 ? b : a;
    let y = top + (A - best.T * best.s) / 2;
    for (const [h, draw] of best.parts) { if (draw) out.push(draw(y, best.s)); y += h * best.s; }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>`;
  return { svg, width: W, height: H, preset: id, channels: channels.map(c => c.key) };
}

async function renderPng(r0) {
  const sharp = require('sharp'); const P = PRESETS[r0.preset];
  let img = sharp(Buffer.from(r0.svg), { density: 72 }).resize(r0.width, r0.height, { fit: 'fill', kernel: 'nearest' });
  if (P.dpi) img = img.withMetadata({ density: P.dpi });
  return img.png({ compressionLevel: 9 }).toBuffer();
}
function renderPdf(r0, { title = 'GrinFud poster' } = {}) {
  const PDFDocument = require('pdfkit'), SVGtoPDF = require('svg-to-pdfkit'); const P = PRESETS[r0.preset];
  const [pw, ph] = P.pdf || [r0.width * 0.75, r0.height * 0.75];
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [pw, ph], margin: 0, info: { Title: title, Creator: 'GrinFud' } }), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    SVGtoPDF(doc, r0.svg, 0, 0, { width: pw, height: ph, preserveAspectRatio: 'xMidYMid meet', fontCallback: (fam, bold) => (bold ? 'Helvetica-Bold' : 'Helvetica') });
    doc.end();
  });
}

const slug = s => String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'grinfud';
const filename = (name, preset, format) => `${slug(name)}-${preset}.${format}`; // preset/format are enums; name is slugged → header-safe

// Express routes. ctx: { requireAdmin, wrap, getSettings, whatsappUrl, siteUrl }
function routes(app, ctx) {
  app.get('/api/admin/poster/presets', ctx.requireAdmin, (req, res) => res.json(Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, width: p.w, height: p.h, kind: p.kind }))));
  app.get('/api/admin/poster/export', ctx.requireAdmin, ctx.wrap(async (req, res) => {
    const opt = parseOptions(req.query); const s = ctx.getSettings();
    const channels = resolveChannels(opt, { whatsappUrl: ctx.whatsappUrl(), siteUrl: ctx.siteUrl() + '/' });
    const r0 = renderSvg({ preset: opt.preset, headline: opt.headline, name: s.business_name, tagline: s.tagline, channels });
    const file = filename(s.business_name, opt.preset, opt.format);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Poster-Channels', r0.channels.join(','));
    if (opt.format === 'svg') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('Content-Disposition', `inline; filename="${file}"`);
      return res.type('image/svg+xml').send(r0.svg);
    }
    const body = opt.format === 'png' ? await renderPng(r0) : await renderPdf(r0, { title: `${s.business_name} — ${PRESETS[opt.preset].label}` });
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.type(opt.format === 'png' ? 'image/png' : 'application/pdf').send(body);
  }));
}

module.exports = { PRESETS, FORMATS, DEFAULT_HEADLINE, parseOptions, resolveChannels, renderSvg, renderPng, renderPdf, qrMatrix, qrGroup, filename, routes };
