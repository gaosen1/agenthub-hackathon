/**
 * SQLite 建表与访问（spec §3.8）。hub-server 独占数据库，其他包不直接碰库。
 */
import Database from 'better-sqlite3';

export type DB = Database.Database;

/** 基线表结构（spec §3.8）。作为 MIGRATIONS 第 1 条，已发布故不可再修改。 */
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

/**
 * 有序迁移表：下标 0 → user_version 1，依次递增。**只追加，不修改已发布项。**
 *
 * 为什么需要迁移而不是继续裸跑 DDL：`CREATE TABLE IF NOT EXISTS` 只保证「表」存在，
 * 一旦表已存在就整条跳过，于是后续新增的「列」在既有 data/hub.sqlite 上永远不会出现，
 * 运行期变成每个请求 500。而所有测试都跑 :memory:（每次都是全新库、DDL 完整），
 * 这类问题在 pnpm test 里完全看不见，只在部署时炸。
 *
 * 基线 DDL 作为第 1 条：全部 IF NOT EXISTS，对既有库是无副作用的 no-op，
 * 因此 user_version=0 的旧库可以直接从头跑一遍迁移。
 */
export const MIGRATIONS: readonly string[] = [BASELINE_DDL];

/** 把库升到最新版本，返回升级后的 user_version */
export function migrate(db: DB): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `数据库版本 ${current} 高于本进程已知的 ${MIGRATIONS.length}，拒绝降级运行（请升级 hub-server）`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    // user_version 也在事务内推进：迁移失败则整条回滚，不会留下半升级状态
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length;
}

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
