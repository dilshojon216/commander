import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** SQLite (node:sqlite) ochish va sxema. `:memory:` testlar uchun. Fayl 0600. */
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      item TEXT NOT NULL,
      size INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE (type, dedup_key)
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_type_seq ON outbox (type, seq);

    CREATE TABLE IF NOT EXISTS usage_seen (
      request_id TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      root TEXT,
      transcript_path TEXT,
      status TEXT,
      last_hook_at INTEGER NOT NULL DEFAULT 0,
      otel_last_at INTEGER NOT NULL DEFAULT 0,
      misses INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcript_offsets (
      path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  if (file !== ':memory:' && existsSync(file)) {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* ruxsat o'zgartirib bo'lmasa ham ishlashda davom etamiz */
    }
  }
  return db;
}

/** BEGIN IMMEDIATE ... COMMIT; xatoda ROLLBACK. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ROLLBACK xatosi asl xatoni yashirmasin */
    }
    throw err;
  }
}
