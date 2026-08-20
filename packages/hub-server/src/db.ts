/**
 * SQLite 建表与访问（spec §3.8）。hub-server 独占数据库，其他包不直接碰库。
 * 迁移机制（S2）：PRAGMA user_version 门控 + 事务化推进 + 拒绝降级；
 * 新迁移追加到 MIGRATIONS 末尾，已发布条目不改。
 */
import Database from 'better-sqlite3';

export type DB = Database.Database;

const BASELINE_DDL = `
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

/** sandbox 实例历史（S5）：执行时长按 ready_at→ended_at 计；故意不加 FK，历史行要比 handoff 活得久 */
const SANDBOXES_DDL = `
CREATE TABLE IF NOT EXISTS sandboxes (
  id INTEGER PRIMARY KEY,
  pod_name TEXT NOT NULL, user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- web | bot
  handoff_id TEXT, bot_id INTEGER,    -- 故意不加 FK
  image TEXT NOT NULL, namespace TEXT NOT NULL,
  status TEXT NOT NULL,               -- provisioning|running|reclaimed|failed|lost
  created_at TEXT NOT NULL, ready_at TEXT, ended_at TEXT,
  duration_seconds INTEGER, reclaim_reason TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_user ON sandboxes(user_id, created_at DESC);
`;

/** per-user 模型凭证 Secret 名 */
export const userModelSecret = (uid: number) => `user-${uid}-model`;

export const MIGRATIONS: Array<(db: DB) => void> = [
  // 1：基线表。IF NOT EXISTS 保证迁移机制上线前的旧库跑本条为 no-op
  (db) => db.exec(BASELINE_DDL),
  // 2：users 表追加模型凭证列（幂等）
  (db) => {
    const cols = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('model_api_key_enc')) db.exec('ALTER TABLE users ADD COLUMN model_api_key_enc TEXT');
    if (!cols.includes('model_base_url')) db.exec('ALTER TABLE users ADD COLUMN model_base_url TEXT');
    if (!cols.includes('model_name')) db.exec('ALTER TABLE users ADD COLUMN model_name TEXT');
  },
  // 3：sandboxes 历史表（S5）
  (db) => db.exec(SANDBOXES_DDL),
];

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`db user_version=${current} 高于本进程已知版本 ${MIGRATIONS.length}，拒绝降级运行`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
