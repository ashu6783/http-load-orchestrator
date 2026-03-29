import Database from 'better-sqlite3';
import path from 'path';

let db: Database.Database;

export const initDb = () => {
  if (db) return db;

  const dbPath =
    process.env.SQLITE_FILE ||
    path.join(__dirname, '../../data/loadtests.db'); // fallback for local

  db = new Database(dbPath);

  // Create tables if not exist
  db.prepare(`
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
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      test_id TEXT,
      status_code INTEGER,
      response_ms INTEGER,
      success INTEGER,
      error_msg TEXT,
      timestamp TEXT
    )
  `).run();

  try {
    db.prepare('ALTER TABLE tests ADD COLUMN last_checkpoint_at TEXT').run();
  } catch {
    // Column already exists
  }
  try {
    db.prepare('ALTER TABLE tests ADD COLUMN completed_requests INTEGER').run();
  } catch {
    // Column already exists
  }

  return db;
};

export const getDb = () => {
  if (!db) {
    throw new Error('DB not initialized. Call initDb() first.');
  }
  return db;
};
