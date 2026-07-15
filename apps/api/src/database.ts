import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

// npm workspaces executes API scripts with apps/api as cwd. Resolve the shared
// root .env from this module so dev, migrate and built production code agree.
config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
});

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DATABASE_POOL_SIZE || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export async function one<T extends QueryResultRow>(sql: string, params: unknown[] = [], client: Queryable = pool): Promise<T | undefined> {
  return (await client.query<T>(sql, params)).rows[0];
}

export async function all<T extends QueryResultRow>(sql: string, params: unknown[] = [], client: Queryable = pool): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
