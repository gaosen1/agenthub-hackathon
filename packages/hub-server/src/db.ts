/**
 * SQLite 建表与访问（spec §3.8）。hub-server 独占数据库，其他包不直接碰库。
 */
import Database from 'better-sqlite3';

export type DB = Database.Database;

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  agent_name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  ws_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task TEXT,
  timeout_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  bot_id INTEGER REFERENCES bots(id),
  bind_chat_id TEXT,
  pod_name TEXT,
  serve_token TEXT,
  runner_token TEXT,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  input_oss_key TEXT,
  output_oss_key TEXT,
  terminal_target TEXT,
  result_manifest TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT
);
CREATE TABLE IF NOT EXISTS handoff_events (
  id INTEGER PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  pod_name TEXT,
  runner_token TEXT,
  status TEXT NOT NULL,
  current_handoff_id TEXT REFERENCES handoffs(id),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_handoffs_user ON handoffs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_handoff ON handoff_events(handoff_id, id);
`;

/** per-user 模型凭证 Secret 名 */
export const userModelSecret = (uid: number) => `user-${uid}-model`;

/** 迁移：users 表追加模型凭证列（幂等） */
function migrate(db: DB): void {
  const cols = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('model_api_key_enc')) db.exec('ALTER TABLE users ADD COLUMN model_api_key_enc TEXT');
  if (!cols.includes('model_base_url')) db.exec('ALTER TABLE users ADD COLUMN model_base_url TEXT');
  if (!cols.includes('model_name')) db.exec('ALTER TABLE users ADD COLUMN model_name TEXT');
}

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  migrate(db);
  return db;
}
