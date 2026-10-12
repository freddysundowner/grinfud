const MAX_IMAGES = 6;
function itemImages(row) {
  let images;
  try { images = JSON.parse(row.images_json || '[]'); } catch { images = []; }
  return Array.isArray(images) && images.length ? images : row.image ? [row.image] : [];
}
function validateImages(value) {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`Choose up to ${MAX_IMAGES} photos per item.`);
  return [...new Set(value.map(url => {
    if (typeof url !== 'string' || !url.trim() || url.length > 2048) throw new Error('Invalid photo URL.');
    url = url.trim();
    if (/[\x00-\x20\\]/.test(url)) throw new Error('Invalid photo URL.');
    if (/^\/(?!\/)/.test(url)) return url;
    try {
      const u = new URL(url);
      if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) return url;
    } catch {}
    throw new Error('Photos must use uploaded image paths or HTTP/HTTPS URLs.');
  }))];
}
function imageFields(body, current) {
  let images;
  if ('images' in body) images = validateImages(body.images);
  else if ('image' in body && body.image !== current?.image) images = validateImages(body.image ? [body.image] : []);
  else images = current ? itemImages(current) : [];
  return { image: images[0] || '', images_json: JSON.stringify(images) };
}
// Compare canonical paths, including legacy absolute URLs and cache-busting queries.
function uploadedFilename(url) {
  try {
    const pathname = decodeURIComponent(new URL(url, 'https://local.invalid').pathname);
    const match = /^\/uploads\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp))$/i.exec(pathname);
    return match ? match[1] : null;
  } catch { return null; }
}
function photoReferences(rows, filename) {
  return rows.filter(row => [...itemImages(row), row.image].some(url => url && uploadedFilename(url) === filename))
    .map(row => ({ id: row.id, name: row.name }));
}
module.exports = { itemImages, validateImages, imageFields, uploadedFilename, photoReferences };
