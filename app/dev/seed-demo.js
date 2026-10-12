// Explicit, repeatable demo-only fixtures. Never calls messaging or payment services.
const db = require('../db');
const { randomBytes } = require('crypto');
const { discountedPrice } = require('../discounts');

const menu = [
  ['fruit-bowl', 'Seasonal Fruit Bowl', 'Banana, mango, pineapple and watermelon pieces.', 220, 'Breakfast', '', 'bowl', 1],
  ['omelette', 'Garden Omelette', 'Two eggs with tomato, onion and fresh coriander.', 250, 'Breakfast', 'cooked', 'plate', 1],
  ['chicken', 'Grilled Chicken & Rice', 'Grilled chicken, steamed rice and a fresh side salad.', 650, 'Lunch & Dinner', 'cooked', 'plate', 1],
  ['beans', 'Bean Stew & Chapati', 'Slow-cooked beans with two chapatis and seasonal greens.', 350, 'Lunch & Dinner', 'cooked', 'plate', 1],
  ['family', 'Family Vegetable Basket', 'Carrots, spinach, tomatoes, onions and potatoes for family meals.', 1200, 'Farm Baskets', 'raw', 'basket', 4],
  ['fruit', 'Mixed Fruit Basket', 'A selection of bananas, oranges, apples and seasonal mangoes.', 850, 'Farm Baskets', 'raw', 'basket', 4],
  ['juice', 'Fresh Mango Juice', 'Freshly blended mango juice, with no added sugar.', 180, 'Drinks', '', 'bottle', 1],
  ['tea', 'Spiced Kenyan Tea', 'Milk tea brewed with ginger and warming spices.', 100, 'Drinks', '', 'cup', 1],
];
const single = (name, choices) => ({ name, type: 'single', required: true, choices: choices.map(label => ({ label, price: 0 })) });

async function main() {
  if (!process.argv.includes('--demo')) throw new Error('Pass --demo to seed the isolated grinfud_demo schema.');
  await db.init('grinfud_demo');
  try {
    const counts = await db.transaction(async tx => {
      await tx.q("SELECT pg_advisory_xact_lock(hashtext('grinfud-demo-fixtures'))");
      await tx.q(`CREATE TABLE IF NOT EXISTS demo_seed_items (
        seed_key TEXT PRIMARY KEY, item_id INTEGER REFERENCES items(id) ON DELETE CASCADE)`);
      const counts = { menu: 0, customers: 0, orders: 0 };
      const items = [];
      for (let k = 0; k < menu.length; k++) {
        const [key, name, description, price, category, prep, unit, serves] = menu[k];
        let item = await tx.one('SELECT i.* FROM items i JOIN demo_seed_items s ON s.item_id=i.id WHERE s.seed_key=$1', [key]);
        if (!item) {
          const options = key === 'chicken' ? [single('Rice choice', ['White rice', 'Pilau rice'])]
            : key === 'tea' ? [single('Sugar', ['No sugar', 'With sugar'])]
            : key === 'omelette' ? [{ name: 'Extras', type: 'multi', required: false, choices: [{ label: 'Avocado', price: 60 }, { label: 'Toast', price: 50 }] }] : [];
          item = await tx.one(`INSERT INTO items
            (name,description,price,category,prep,unit,serves,sort,options_json,discount_type,discount_value)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [`${name} (Demo)`, description, price, category, prep, unit, serves, k + 10, JSON.stringify(options),
            key === 'family' ? 'percent' : key === 'juice' ? 'fixed' : 'none', key === 'family' ? 10 : key === 'juice' ? 20 : 0]);
          await tx.q('INSERT INTO demo_seed_items VALUES ($1,$2)', [key, item.id]);
          counts.menu++;
        }
        items.push(item);
      }
      for (let n = 1; n <= 6; n++) {
        const inserted = await tx.q(`INSERT INTO customers(phone,name,source)
          VALUES ($1,$2,'web') ON CONFLICT DO NOTHING RETURNING phone`,
        [`25400000010${n}`, `Demo Customer ${n}`]);
        counts.customers += inserted.length;
      }
      const statuses = ['new', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
      for (let n = 0; n < 15; n++) {
        const customer = n % 6 + 1;
        const item = items[n % items.length];
        const price = discountedPrice(item);
        const qty = n % 3 + 1;
        const options = JSON.parse(item.options_json || '[]').filter(g => g.required).map(g => ({
          group: g.name, choice: g.choices[0].label, price: g.choices[0].price || 0,
        }));
        const unit = price.price + options.reduce((sum, c) => sum + c.price, 0);
        const subtotal = unit * qty, fee = 100;
        const status = statuses[n % statuses.length];
        const created = new Date(Date.now() - n * 4 * 3600000);
        const delivered = status === 'delivered' ? new Date(created.getTime() + 3600000) : null;
        const lines = [{ item_id: item.id, name: item.name, qty, unit_price: unit, line_total: subtotal,
          original_unit_price: unit + price.original_price - price.price, discount_per_unit: price.original_price - price.price,
          options, note: 'Demo sample only' }];
        const inserted = await tx.q(`INSERT INTO orders
          (code,source,customer_name,phone,location,delivery_date,delivery_time,notes,items_json,
           subtotal,delivery_fee,total,status,notified,track_token,created_at,updated_at,delivered_at)
          VALUES ($1,'web',$2,$3,'Demo delivery address',$4,'12:00–14:00',
            'DEMO ONLY — synthetic order; do not fulfil or collect payment.',$5,$6,$7,$8,$9,1,$10,$11,$11,$12)
          ON CONFLICT (code) DO NOTHING RETURNING id`,
        [`DEMO-${2001 + n}`, `Demo Customer ${customer}`, `25400000010${customer}`,
          created.toISOString().slice(0, 10), JSON.stringify(lines), subtotal, fee, subtotal + fee, status,
          randomBytes(24).toString('base64url'), created, delivered]);
        counts.orders += inserted.length;
      }
      return counts;
    });
    console.log('Demo fixtures added:', counts);
  } finally { await db.close(); }
}
main().catch(e => { console.error('Demo seed failed:', e.message); process.exitCode = 1; });
