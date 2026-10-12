// Public links follow the current request, not a process-global "last visitor".
// Async context also follows order notifications scheduled from that request.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
function publicOrigin(value) {
  try {
    const u = new URL(value), h = u.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password ||
        h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
        !h.includes('.') || /^(127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return '';
    return u.origin;
  } catch { return ''; }
}
function requestOrigin(req) {
  const trusted = req.app.get('trust proxy fn')?.(req.socket.remoteAddress, 0);
  const forwarded = trusted && req.get('x-forwarded-host');
  const host = String(forwarded || req.get('host') || '').split(',')[0].trim();
  // Authority only: reject paths, credentials and ambiguous host-header content.
  if (!host || /[\/\\@?#\s]/.test(host)) return '';
  return publicOrigin(`${req.protocol}://${host}`);
}
const origin = () => context.getStore() || publicOrigin(process.env.PUBLIC_URL || '');
const absolute = path => origin() + path;
const requireOrigin = () => {
  const value = origin();
  if (!value) throw new Error('Open this page using the website’s hosted address to generate public links.');
  return value;
};
const middleware = (req, res, next) => context.run(requestOrigin(req) || publicOrigin(process.env.PUBLIC_URL || ''), next);
module.exports = { publicOrigin, requestOrigin, origin, absolute, requireOrigin, middleware };
