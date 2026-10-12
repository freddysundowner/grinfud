// Explicit, repeatable migration. Never removes or modifies local originals or database URLs.
const path = require('node:path');
const { migratePhotos } = require('./photo-storage');
const directories = process.argv.slice(2);
if (!directories.length) directories.push(process.env.DATA_DIR || path.join(__dirname, 'data'), path.join(__dirname, 'data-demo'));
(async () => {
  for (const directory of [...new Set(directories.map(dir => path.resolve(dir)))]) {
    const result = await migratePhotos(path.join(directory, 'uploads'));
    console.log(`${directory}: ${result.copied} copied, ${result.verified} SHA-256 verified; originals retained.`);
  }
})().catch(error => { console.error('Photo migration failed:', error.message); process.exitCode = 1; });
