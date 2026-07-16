import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, transaction } from './database.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
for (const name of files) {
  const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
  if (applied.rowCount) continue;
  const sql = await readFile(join(migrationsDir, name), 'utf8');
  await transaction(async (client) => {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
  });
  console.log(`Applied migration ${name}`);
}
await pool.end();
