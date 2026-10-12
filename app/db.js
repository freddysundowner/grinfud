// PostgreSQL access (works with PostgreSQL 12+).
//
//   DATABASE_URL   postgresql://user:password@localhost:5432/grinfud
//
// q(sql, params) → rows · one(sql, params) → first row or undefined
const { Pool, types } = require('pg');

types.setTypeParser(20, Number); // BIGINT (counts, millisecond timestamps) as plain numbers

let pool = null;

// `schema` keeps demo data apart from real orders inside the same database.
async function init(schema) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set. Example: postgresql://grinfud:password@localhost:5432/grinfud');
  if (schema) {
    const boot = new Pool({ connectionString, max: 1 });
    try { await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); } finally { await boot.end(); }
  }
  pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  // A dropped idle connection (database restart) must not crash the app; the pool reconnects on the next query.
  pool.on('error', e => console.error('[db] idle connection error:', e.message));
  await pool.query('SELECT 1');
}

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const close = () => (pool ? pool.end() : Promise.resolve());
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = async (sql, params) => (await client.query(sql, params)).rows;
    const result = await fn({ q, one: async (sql, params) => (await q(sql, params))[0] });
    await client.query('COMMIT'); return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { init, q, one, close, transaction };
