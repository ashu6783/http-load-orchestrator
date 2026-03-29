import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;

function buildPoolConfig(): PoolConfig {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'loadtests',
  };
}

export async function initDb(): Promise<Pool> {
  if (pool) return pool;

  pool = new Pool(buildPoolConfig());

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tests (
      id TEXT PRIMARY KEY,
      url TEXT,
      method TEXT,
      headers TEXT,
      payload TEXT,
      request_count INTEGER,
      concurrency INTEGER,
      status TEXT,
      created_at TEXT,
      completed_at TEXT,
      trace_id TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      test_id TEXT,
      status_code INTEGER,
      response_ms INTEGER,
      success INTEGER,
      error_msg TEXT,
      timestamp TEXT
    )
  `);

  await pool.query(`
    ALTER TABLE tests ADD COLUMN IF NOT EXISTS last_checkpoint_at TEXT
  `);
  await pool.query(`
    ALTER TABLE tests ADD COLUMN IF NOT EXISTS completed_requests INTEGER
  `);

  return pool;
}

export function getDb(): Pool {
  if (!pool) {
    throw new Error('DB not initialized. Call initDb() first.');
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
