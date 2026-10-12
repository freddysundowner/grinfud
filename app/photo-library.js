const fs = require('node:fs');
const path = require('node:path');
const { uploadedFilename, photoReferences, itemImages } = require('./item-images');

function photoLibrary(directory, db, { storage, sharedSchemas = false, legacyDirectories = [] } = {}) {
  const directories = [...new Set([directory, ...legacyDirectories].map(dir => path.resolve(dir)))];
  function filePath(filename, dir = directory) {
    if (typeof filename !== 'string' || uploadedFilename('/uploads/' + filename) !== filename) {
      throw Object.assign(new Error('Invalid photo filename.'), { status: 400 });
    }
    return path.join(dir, filename);
  }
  async function localExists(filename, dir) {
    try { return (await fs.promises.lstat(filePath(filename, dir))).isFile(); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  async function exists(filename) {
    if (storage && await storage.photoExists(filename)) return true;
    for (const dir of directories) if (await localExists(filename, dir)) return true;
    return false;
  }
  async function referenceTables(tx) {
    if (!sharedSchemas) return ['items'];
    // Demo and live menus share the same object prefix. Neither can delete the other's files.
    const rows = await tx.q("SELECT schemaname FROM pg_tables WHERE tablename = 'items' AND schemaname IN ('public', 'grinfud_demo') ORDER BY schemaname");
    return rows.map(row => `"${row.schemaname}"."items"`);
  }
  async function references(tx, tables) {
    const rows = [];
    for (const table of tables) rows.push(...await tx.q(`SELECT id, name, image, images_json FROM ${table}`));
    return rows;
  }
  // The table lock also conflicts with ordinary item writes on other server instances.
  async function withItemsLock(fn) {
    return db.transaction(async tx => {
      tx.photoTables = await referenceTables(tx);
      if (!tx.photoTables.length) throw new Error('Menu references are unavailable.');
      await tx.q(`LOCK TABLE ${tx.photoTables.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
      return fn(tx);
    });
  }
  async function assertImages(fields) {
    for (const url of itemImages(fields)) {
      const filename = uploadedFilename(url);
      if (filename && !(await exists(filename))) throw new Error('A selected photo no longer exists. Choose another photo.');
    }
  }
  async function list() {
    const rows = await references(db, await referenceTables(db));
    const names = new Set(storage ? await storage.listPhotos() : []);
    for (const dir of directories) {
      let files;
      try { files = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      files.filter(f => f.isFile() && uploadedFilename('/uploads/' + f.name) === f.name).forEach(f => names.add(f.name));
    }
    return [...names].map(filename => ({ filename, url: '/uploads/' + filename, references: photoReferences(rows, filename) }))
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }
  async function remove(filename, confirmed) {
    filePath(filename);
    if (confirmed !== true) throw Object.assign(new Error('Confirm permanent photo deletion.'), { status: 400 });
    return withItemsLock(async tx => {
      const refs = photoReferences(await references(tx, tx.photoTables), filename);
      if (refs.length) throw Object.assign(new Error('Photo is still used by: ' + refs.map(r => r.name).join(', ')), { status: 409 });
      if (!(await exists(filename))) throw Object.assign(new Error('Photo not found.'), { status: 404 });
      // Remove legacy copies too, or the compatibility serving route would resurrect the photo.
      for (const dir of directories) if (await localExists(filename, dir)) await fs.promises.unlink(filePath(filename, dir));
      if (storage) await storage.deletePhoto(filename);
      return { ok: true };
    });
  }
  return { list, remove, assertImages, withItemsLock };
}
module.exports = { photoLibrary };
