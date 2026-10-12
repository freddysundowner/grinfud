// Explicit VPS storage backend. The containing DATA_DIR must be backed up.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const directory = () => path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
function missing(error) {
  if (error.code === 'ENOENT') error.code = 404;
  return error;
}
function file(name) {
  const destination = path.join(directory(), name);
  async function metadata() {
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isFile()) throw Object.assign(new Error('Not a regular photo.'), { code: 404 });
      return [{ size: stat.size }];
    } catch (error) { throw missing(error); }
  }
  return {
    async save(bytes) {
      await fs.mkdir(directory(), { recursive: true, mode: 0o750 });
      const temporary = path.join(directory(), `.upload-${randomUUID()}`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o640 });
        // Atomic publication with no overwrite, even under concurrent uploads.
        try { await fs.link(temporary, destination); }
        catch (error) { if (error.code === 'EEXIST') error.code = 412; throw error; }
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
    getMetadata: metadata,
    createReadStream: () => createReadStream(destination),
    async download() { await metadata(); return [await fs.readFile(destination)]; },
    async exists() {
      try { await metadata(); return [true]; }
      catch (error) { if (error.code === 404) return [false]; throw error; }
    },
    async delete() {
      try { await metadata(); await fs.unlink(destination); }
      catch (error) { if (error.code !== 404 && error.code !== 'ENOENT') throw error; }
    },
  };
}
async function list(validName) {
  try {
    return (await fs.readdir(directory(), { withFileTypes: true }))
      .filter(entry => entry.isFile() && validName(entry.name)).map(entry => entry.name);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
module.exports = { file, list };
