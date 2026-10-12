// Menu photos are public; only this dedicated prefix is exposed, never the bucket root.
const { Storage } = require('@google-cloud/storage');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const client = new Storage({
  credentials: {
    audience: 'replit',
    subject_token_type: 'access_token',
    token_url: 'http://127.0.0.1:1106/token',
    type: 'external_account',
    credential_source: {
      url: 'http://127.0.0.1:1106/credential',
      format: { type: 'json', subject_token_field_name: 'access_token' },
    },
    universe_domain: 'googleapis.com',
  },
  projectId: '',
});
function validName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}\.(?:jpe?g|png|webp)$/i.test(name);
}
function objectFile(name) {
  if (!validName(name)) throw new Error('Invalid photo filename.');
  if (process.env.PHOTO_STORAGE === 'local') return require('./photo-storage-local').file(name);
  if (process.env.PHOTO_STORAGE && process.env.PHOTO_STORAGE !== 'replit') throw new Error('Unsupported PHOTO_STORAGE backend.');
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucket) throw new Error('App Storage is not configured.');
  return client.bucket(bucket).file(`grinfud/menu-photos/${name}`);
}
function contentType(name) {
  return /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
}
async function savePhoto(name, bytes) {
  await objectFile(name).save(bytes, {
    resumable: false,
    validation: 'crc32c',
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType: contentType(name), cacheControl: 'public, max-age=604800' },
  });
}
async function listPhotos() {
  if (process.env.PHOTO_STORAGE === 'local') return require('./photo-storage-local').list(validName);
  if (process.env.PHOTO_STORAGE && process.env.PHOTO_STORAGE !== 'replit') throw new Error('Unsupported PHOTO_STORAGE backend.');
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucket) throw new Error('App Storage is not configured.');
  const prefix = 'grinfud/menu-photos/';
  const [files] = await client.bucket(bucket).getFiles({ prefix });
  return files.map(file => file.name.slice(prefix.length)).filter(validName);
}
async function photoExists(name) {
  const [exists] = await objectFile(name).exists();
  return exists;
}
async function deletePhoto(name) {
  await objectFile(name).delete({ ignoreNotFound: true });
}
function servePhotos(localDir, { getFile = objectFile } = {}) {
  return async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
    let name;
    try { name = decodeURIComponent(req.path.slice(1)); } catch { return res.sendStatus(400); }
    if (!validName(name)) return res.sendStatus(404);
    try {
      const file = getFile(name);
      const [metadata] = await file.getMetadata();
      // A client may leave while the metadata request is in flight. Do not
      // start a media download (including HEAD responses) for a dead socket.
      if (res.destroyed) return;
      res.set({
        'Content-Type': contentType(name),
        'Content-Length': metadata.size,
        'Cache-Control': 'public, max-age=604800',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      await pipeline(file.createReadStream({ validation: 'crc32c' }), res);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (Number(error.code) === 404) {
        // Read-only compatibility while legacy files are being migrated.
        return res.sendFile(name, { root: localDir, dotfiles: 'deny', maxAge: '7d' }, err => {
          if (err && !res.headersSent && !res.destroyed) res.sendStatus(err.statusCode === 404 ? 404 : 500);
        });
      }
      console.error('[photos] Storage read failed:', error.code || error.name);
      res.status(503).json({ error: 'Photo storage is temporarily unavailable.' });
    }
  };
}
async function ensurePhoto(name, bytes) {
  let copied = false;
  try { await savePhoto(name, bytes); copied = true; }
  catch (error) { if (Number(error.code) !== 412) throw error; }
  const [stored] = await objectFile(name).download();
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  if (hash(bytes) !== hash(stored)) throw new Error(`Storage verification failed: ${name}; original retained.`);
  return copied;
}
async function migratePhotos(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { copied: 0, verified: 0 }; throw error; }
  const result = { copied: 0, verified: 0 };
  for (const entry of entries) {
    if (!entry.isFile() || !validName(entry.name)) throw new Error(`Unsupported upload entry: ${entry.name}`);
    const bytes = await fs.readFile(path.join(directory, entry.name));
    if (await ensurePhoto(entry.name, bytes)) result.copied++;
    result.verified++;
  }
  return result;
}
module.exports = { validName, objectFile, savePhoto, ensurePhoto, servePhotos, migratePhotos, listPhotos, photoExists, deletePhoto };
