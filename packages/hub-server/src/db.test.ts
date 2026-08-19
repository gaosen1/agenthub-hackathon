/**
 * 迁移机制（S2）：user_version 门控 + 事务化推进。
 *
 * 重点验证「迁移机制上线前就存在的库」——它有完整的基线表但 user_version=0，
 * 这正是线上 data/hub.sqlite 的状态。这类场景在 :memory: 测试里默认永远不会出现，
 * 所以必须显式构造。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDb, type DB } from './db.js';

/** 造一个「迁移机制上线前」的旧库：表齐全，但没有版本号 */
function legacyDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec('PRAGMA user_version = 0');
  return db;
}

const version = (db: DB) => db.pragma('user_version', { simple: true }) as number;

describe('db 迁移', () => {
  it('全新库直接升到最新版本', () => {
    const db = openDb(':memory:');
    expect(version(db)).toBe(MIGRATIONS.length);
  });

  it('旧库（有表、无版本号）升级后数据不丢且版本到位', () => {
    const db = legacyDb();
    db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1,'devuser','h','t0')").run();
    db.prepare(
      `INSERT INTO handoffs (id,user_id,agent_name,workspace_path,ws_hash,session_id,status,kind,
        base_commit,branch,created_at,updated_at)
       VALUES ('hf-abc123',1,'qwen','/w','wh','sess','done','web','a41c9e0','main','t0','t0')`,
    ).run();
    expect(version(db)).toBe(0);

    migrate(db);

    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT username FROM users WHERE id=1').get()).toEqual({ username: 'devuser' });
    expect(db.prepare("SELECT status FROM handoffs WHERE id='hf-abc123'").get()).toEqual({ status: 'done' });
  });

  it('重复迁移幂等', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1,'devuser','h','t0')").run();

    migrate(db);
    migrate(db);

    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 1 });
  });

  it('库版本高于本进程已知版本时拒绝运行，不静默降级', () => {
    const db = openDb(':memory:');
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);

    expect(() => migrate(db)).toThrow(/拒绝降级运行/);
  });

  it('每条迁移都建立了后续切片依赖的基线表', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'handoffs', 'handoff_events', 'bots']));
  });
});
