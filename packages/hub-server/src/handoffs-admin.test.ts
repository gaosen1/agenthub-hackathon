/**
 * 列表面板归档/删除：
 * - 默认列表隐藏已归档，?archived=1 只显示已归档；
 * - 非终态归档/删除 → 409（还被 worker/Pod 引用，防孤儿）；
 * - 删除级联清事件，detail 404。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import { nowIso } from './store.js';
import type { OssSigner } from './oss.js';

const fakeSigner: OssSigner = {
  signPut: async (k) => `https://oss.fake/put/${k}`,
  signGet: async (k) => `https://oss.fake/get/${k}`,
};

let db: DB;
let app: FastifyInstance;
let token: string;

function insertHandoff(id: string, status: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO handoffs (id, user_id, agent_name, workspace_path, ws_hash, session_id, task, timeout_minutes,
      status, kind, bot_id, base_commit, branch, input_oss_key, created_at, updated_at, last_active_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 1, 'demo', '/w', 'w', 's', null, 30, status, 'web', null, 'b', 'main', `handoffs/1/${id}/input.tar.gz`, at, at, at);
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = buildApp({ db, signer: fakeSigner, secret: 's' });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
  token = (reg.json() as { token: string }).token;
});

afterEach(async () => {
  await app.close();
  db.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });
const list = async (qs = '') =>
  ((await app.inject({ method: 'GET', url: `/api/handoffs${qs}`, headers: auth() })).json() as {
    items: Array<{ id: string; archived: boolean }>;
  }).items;

describe('列表面板归档/删除', () => {
  it('归档：默认列表隐藏，?archived=1 显示；取消归档恢复', async () => {
    insertHandoff('hf-a1', 'done');
    expect(await list()).toHaveLength(1);

    const ar = await app.inject({ method: 'POST', url: '/api/handoffs/hf-a1/archive', headers: auth(), payload: { archived: true } });
    expect(ar.statusCode).toBe(200);
    expect(await list()).toHaveLength(0);
    const archived = await list('?archived=1');
    expect(archived).toHaveLength(1);
    expect(archived[0]!.archived).toBe(true);

    await app.inject({ method: 'POST', url: '/api/handoffs/hf-a1/archive', headers: auth(), payload: { archived: false } });
    expect(await list()).toHaveLength(1);
  });

  it('非终态归档/删除 → 409', async () => {
    insertHandoff('hf-a2', 'running');
    expect((await app.inject({ method: 'POST', url: '/api/handoffs/hf-a2/archive', headers: auth(), payload: { archived: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/handoffs/hf-a2', headers: auth() })).statusCode).toBe(409);
  });

  it('删除：级联清事件，detail 404', async () => {
    insertHandoff('hf-a3', 'done');
    db.prepare('INSERT INTO handoff_events (handoff_id, kind, payload, at) VALUES (?,?,?,?)').run('hf-a3', 'status', 'done', nowIso());

    expect((await app.inject({ method: 'DELETE', url: '/api/handoffs/hf-a3', headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/handoffs/hf-a3', headers: auth() })).statusCode).toBe(404);
    expect(db.prepare('SELECT count(*) c FROM handoff_events WHERE handoff_id=?').get('hf-a3')).toEqual({ c: 0 });
  });
});

describe('Web Shell 入口', () => {
  it('running web 返回可达 127.0.0.1 地址（探针过）；非 running → 409', async () => {
    await app.close();
    // 探针需真监听：本地起一个替身 shell
    const { createServer } = await import('node:http');
    const shellSrv = createServer((_q, s) => s.end('<html>shell</html>'));
    await new Promise<void>((r) => shellSrv.listen(0, '127.0.0.1', () => r()));
    const shellPort = (shellSrv.address() as { port: number }).port;
    const connector = {
      getBaseUrl: async () => `http://127.0.0.1:${shellPort}`,
      invalidate: () => undefined,
      dispose: async () => undefined,
      browserReachable: (url: string) => url.startsWith('http://127.0.0.1'),
    };
    app = buildApp({
      db,
      signer: fakeSigner,
      secret: 's',
      sandbox: { connector, orchestrator: {} as never, namespace: 'agenthub' },
    });
    insertHandoff('hf-sh1', 'running');
    db.prepare('UPDATE handoffs SET pod_name=? WHERE id=?').run('ah-web-sh1', 'hf-sh1');
    const ok = await app.inject({ method: 'GET', url: '/api/handoffs/hf-sh1/shell-url', headers: auth() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ url: `http://127.0.0.1:${shellPort}/session/s`, reachable: true });

    insertHandoff('hf-sh2', 'done');
    // 终态走 replay：无返回包时回退 reachable:false（前端回退 HistoryView），不再 409
    const bad = await app.inject({ method: 'GET', url: '/api/handoffs/hf-sh2/shell-url', headers: auth() });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toEqual({ url: '', reachable: false });
    shellSrv.close();
  });
});
