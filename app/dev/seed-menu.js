// Explicit sample menu only: no customer records, messages, orders or payments.
const fs = require('node:fs/promises');
const path = require('node:path');
const catalog = [
  { key: 'breakfast', name: 'Breakfast Basket (Sample)', description: '2 eggs, a serving of nduma or ngwaci, and seasonal fruit.', price: 299, category: 'Breakfast', prep: 'cooked', unit: 'basket', serves: 1, file: 'breakfast-basket.jpg',
    options: [{ name: 'Nduma or ngwaci?', type: 'single', required: true, choices: [{ label: 'Nduma', price: 0 }, { label: 'Ngwaci', price: 0 }] }] },
  { key: 'fruit', name: 'Seasonal Fruit Bowl (Sample)', description: 'A refreshing selection of seasonal fruit. Photo is illustrative.', price: 220, category: 'Breakfast', prep: '', unit: 'bowl', serves: 1, file: 'sample-fruit.webp', options: [] },
  { key: 'vegetables', name: 'Family Vegetable Basket (Sample)', description: 'A seasonal selection of fresh vegetables for family meals. Photo is illustrative.', price: 1200, category: 'Farm Baskets', prep: 'raw', unit: 'basket', serves: 4, file: 'sample-vegetables.webp', options: [] },
];

async function seedMenu(db, storage) {
  return db.transaction(async tx => {
    await tx.q("SELECT pg_advisory_xact_lock(hashtext('grinfud-sample-menu'))");
    await tx.q(`CREATE TABLE IF NOT EXISTS sample_menu_seeds (
      seed_key TEXT PRIMARY KEY, item_id INTEGER REFERENCES items(id) ON DELETE SET NULL)`);
    let added = 0, skipped = 0;
    for (const item of catalog) {
      // Even deleted sample items stay recorded: reruns never resurrect them.
      if (await tx.one('SELECT seed_key FROM sample_menu_seeds WHERE seed_key=$1', [item.key])) { skipped++; continue; }
      const filename = 'seed-menu-' + item.file;
      const bytes = await fs.readFile(path.join(__dirname, '..', 'seed', item.file));
      await storage.ensurePhoto(filename, bytes);
      const url = '/uploads/' + filename;
      const row = await tx.one(`INSERT INTO items
        (name,description,price,category,prep,unit,serves,image,images_json,options_json,sort)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [item.name,item.description,item.price,item.category,item.prep,item.unit,item.serves,url,JSON.stringify([url]),JSON.stringify(item.options),100 + added]);
      await tx.q('INSERT INTO sample_menu_seeds(seed_key,item_id) VALUES ($1,$2)', [item.key,row.id]);
      added++;
    }
    return { added, skipped };
  });
}
async function main() {
  if (!process.argv.includes('--confirm')) throw new Error('Pass --confirm to add three visible sample menu items with photos. Existing records are preserved.');
  const db = require('../db');
  try {
    await db.init();
    console.log('Sample menu:', await seedMenu(db, require('../photo-storage')));
  } finally { await db.close(); }
}
if (require.main === module) main().catch(e => { console.error('Menu seed failed:', e.message); process.exitCode = 1; });
module.exports = { seedMenu, catalog };
