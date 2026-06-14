import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow overriding the data directory (useful on Render persistent disks).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'xenara.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    password    TEXT NOT NULL,
    settings    TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT 'New chat',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
`);

// --- Migrations: add owner + API key columns if missing ---
function addColumn(sql) {
  try {
    db.exec(sql);
  } catch {
    /* column already exists */
  }
}
addColumn("ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0");
addColumn("ALTER TABLE users ADD COLUMN api_key_hash TEXT");        // SHA-256 of key
addColumn("ALTER TABLE users ADD COLUMN api_key_preview TEXT");      // shown in UI
addColumn("ALTER TABLE users ADD COLUMN api_key_created INTEGER");
addColumn("ALTER TABLE users ADD COLUMN api_key_last_used INTEGER");
addColumn("ALTER TABLE users ADD COLUMN totp_secret TEXT");          // optional 2FA
addColumn("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_apikeyhash ON users(api_key_hash) WHERE api_key_hash IS NOT NULL;');

// Track how much the model has learned from live questions.
db.exec(`
  CREATE TABLE IF NOT EXISTS learn_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chars       INTEGER NOT NULL,
    loss        REAL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    endpoint    TEXT NOT NULL,
    via_key     INTEGER NOT NULL DEFAULT 0,
    in_chars    INTEGER NOT NULL DEFAULT 0,
    out_chars   INTEGER NOT NULL DEFAULT 0,
    status      INTEGER NOT NULL DEFAULT 200,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user ON api_usage(user_id, created_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT,
    event       TEXT NOT NULL,
    ip          TEXT,
    detail      TEXT,
    created_at  INTEGER NOT NULL
  );
`);

export function recordUsage({ userId, endpoint, viaKey, inChars = 0, outChars = 0, status = 200 }) {
  try {
    db.prepare(
      `INSERT INTO api_usage (user_id, endpoint, via_key, in_chars, out_chars, status, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(userId, endpoint, viaKey ? 1 : 0, inChars, outChars, status, Date.now());
  } catch {
    /* non-fatal */
  }
}

export function recordAudit({ userId = null, event, ip = null, detail = null }) {
  try {
    db.prepare('INSERT INTO audit_events (user_id, event, ip, detail, created_at) VALUES (?,?,?,?,?)')
      .run(userId, event, ip, detail ? JSON.stringify(detail) : null, Date.now());
  } catch {
    /* non-fatal */
  }
}

export function ownerExists() {
  return !!db.prepare('SELECT 1 FROM users WHERE is_owner = 1 LIMIT 1').get();
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export default db;
