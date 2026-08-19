/**
 * D1 验收测试（spec §7 阶段 D1）：
 * auth 注册/登录/错 token；handoffs created→uploaded→queued；非法流转 ERR_STATE；跨用户 403
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import type { OssSigner } from './oss.js';

const fakeSigner: OssSigner = {
  signPut: async (key) => `https://oss.fake/put/${key}?sig=x`,
  signGet: async (key) => `https://oss.fake/get/${key}?sig=x`,
};

const CREATE_BODY = {
  agentName: 'demo',
  workspacePath: '/Users/x/demo',
  wsHash: 'demo-abc123def456',
  sessionId: 'sess-1',
  baseCommit: 'a1b2c3d',
  branch: 'main',
  kind: 'web',
  timeoutMinutes: 30,
};

let db: DB;
let app: FastifyInstance;

const register = async (username: string) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'secret123' },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
};

const createHandoff = async (token: string) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/handoffs',
    headers: { authorization: `Bearer ${token}` },
    payload: CREATE_BODY,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { handoffId: string; uploadUrl: string; webUrl: string };
};

beforeEach(() => {
  db = openDb(':memory:');
  app = buildApp({ db, signer: fakeSigner, secret: 'test-secret' });
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe('auth', () => {
  it('注册后可登录，密码错返回 ERR_AUTH', async () => {
    await register('alice');
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'secret123' } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { user: { username: string } }).user.username).toBe('alice');

    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'wrong-pass' } });
    expect(bad.statusCode).toBe(401);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('ERR_AUTH');
  });

  it('重复用户名 / 参数不合法返回 ERR_VALIDATION', async () => {
    await register('alice');
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
    expect(dup.statusCode).toBe(400);
    const short = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: '', password: '' } });
    expect(short.statusCode).toBe(400);
    expect((short.json() as { error: { code: string } }).error.code).toBe('ERR_VALIDATION');
  });

  it('无 token / 伪造 token 访问受保护接口返回 401', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/handoffs' });
    expect(none.statusCode).toBe(401);
    const forged = await app.inject({ method: 'GET', url: '/api/handoffs', headers: { authorization: 'Bearer aaa.bbb.ccc' } });
    expect(forged.statusCode).toBe(401);
  });
});

describe('handoff 状态机', () => {
  it('created → uploaded → queued，时间线完整', async () => {
    const token = await register('alice');
    const { handoffId, uploadUrl } = await createHandoff(token);
    expect(uploadUrl).toContain(`handoffs/1/${handoffId}/input.tar.gz`);

    const up = await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/uploaded`, headers: { authorization: `Bearer ${token}` } });
    expect(up.statusCode).toBe(200);
    expect((up.json() as { status: string }).status).toBe('queued');

    const detail = await app.inject({ method: 'GET', url: `/api/handoffs/${handoffId}`, headers: { authorization: `Bearer ${token}` } });
    const body = detail.json() as { status: string; timeline: Array<{ status: string }> };
    expect(body.status).toBe('queued');
    expect(body.timeline.map((t) => t.status)).toEqual(['created', 'uploaded', 'queued']);
  });

  it('对终态任务 cancel 返回 ERR_STATE；对 queued 任务 cancel 成功', async () => {
    const token = await register('alice');
    const { handoffId } = await createHandoff(token);
    await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/uploaded`, headers: { authorization: `Bearer ${token}` } });

    const first = await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/cancel`, headers: { authorization: `Bearer ${token}` } });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { status: string }).status).toBe('cancelled');

    const again = await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/cancel`, headers: { authorization: `Bearer ${token}` } });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('ERR_STATE');
  });

  it('重复 uploaded 回执是非法流转（queued → uploaded 拒绝）', async () => {
    const token = await register('alice');
    const { handoffId } = await createHandoff(token);
    await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/uploaded`, headers: { authorization: `Bearer ${token}` } });
    const dup = await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/uploaded`, headers: { authorization: `Bearer ${token}` } });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: { code: string } }).error.code).toBe('ERR_STATE');
  });

  it('未完成任务 pull-intent 返回 ERR_NOT_READY', async () => {
    const token = await register('alice');
    const { handoffId } = await createHandoff(token);
    const res = await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/pull-intent`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR_NOT_READY');
  });
});

describe('模型凭证（per-user 隔离）', () => {
  it('PUT /api/account/model 加密存储；GET 返回 hasKey 且不泄露明文', async () => {
    const token = await register('alice');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/account/model',
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: 'sk-secret-key-123', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
    });
    expect(res.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/account/model', headers: { authorization: `Bearer ${token}` } });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { hasKey: boolean; baseUrl: string; model: string };
    expect(body.hasKey).toBe(true);
    expect(body.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(body.model).toBe('qwen3-coder-plus');
    // 响应不包含明文 key
    expect(JSON.stringify(body)).not.toContain('sk-secret-key-123');

    // 数据库里也是密文
    const row = db.prepare('SELECT model_api_key_enc FROM users WHERE id=1').get() as { model_api_key_enc: string };
    expect(row.model_api_key_enc).not.toContain('sk-secret-key-123');
  });

  it('未配模型凭证的用户 GET 返回 hasKey=false', async () => {
    const token = await register('bob');
    const res = await app.inject({ method: 'GET', url: '/api/account/model', headers: { authorization: `Bearer ${token}` } });
    expect((res.json() as { hasKey: boolean }).hasKey).toBe(false);
  });

  it('无 token 访问模型凭证接口返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/account/model' });
    expect(res.statusCode).toBe(401);
  });
});

describe('归属隔离（CP-1 验收项）', () => {
  it('用户 B 访问用户 A 的 handoff 返回 403', async () => {
    const tokenA = await register('alice');
    const tokenB = await register('bob');
    const { handoffId } = await createHandoff(tokenA);
    const res = await app.inject({ method: 'GET', url: `/api/handoffs/${handoffId}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR_FORBIDDEN');
  });

  it('list 只返回本人任务，支持 status 过滤', async () => {
    const tokenA = await register('alice');
    const tokenB = await register('bob');
    await createHandoff(tokenA);
    await createHandoff(tokenA);
    await createHandoff(tokenB);
    const res = await app.inject({ method: 'GET', url: '/api/handoffs?status=created', headers: { authorization: `Bearer ${tokenA}` } });
    expect((res.json() as { items: unknown[] }).items).toHaveLength(2);
  });
});
