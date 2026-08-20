/**
 * 设置面板（S16/S17）：
 * - webhook 加密落库，GET 响应永不回明文（grep 响应体确认）；
 * - token 轮换后旧 token 立刻 401，新 token 200；不接受 tv ?? 1 兜底。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import type { OssSigner } from './oss.js';

const fakeSigner: OssSigner = {
  signPut: async (k) => `https://oss.fake/put/${k}`,
  signGet: async (k) => `https://oss.fake/get/${k}`,
};

let db: DB;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  db = openDb(':memory:');
  app = buildApp({ db, signer: fakeSigner, secret: 'test-secret' });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
  token = (reg.json() as { token: string }).token;
});

afterEach(async () => {
  await app.close();
  db.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('S16 设置存取', () => {
  it('默认值：notifyStatusChange 开、webhook 未配置；server 段真实来源', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).json() as {
      settings: { notifyStatusChange: boolean; webhook: { configured: boolean; masked: string | null } };
      server: { signedUrlTtlSeconds: number; idleTtlMinutes: number };
    };
    expect(body.settings.notifyStatusChange).toBe(true);
    expect(body.settings.webhook.configured).toBe(false);
    expect(body.server.signedUrlTtlSeconds).toBe(1800);
    expect(body.server.idleTtlMinutes).toBe(120);
  });

  it('PATCH webhook 后 GET 只回掩码，响应体 grep 不到明文', async () => {
    const plain = 'https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890';
    const patch = await app.inject({ method: 'PATCH', url: '/api/settings', headers: auth(), payload: { webhook: plain } });
    expect(patch.statusCode).toBe(200);
    expect(patch.body).not.toContain('abcdef1234567890');

    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: auth() });
    const body = res.json() as { settings: { webhook: { configured: boolean; masked: string } } };
    expect(body.settings.webhook.configured).toBe(true);
    expect(body.settings.webhook.masked).toContain('••••7890');
    expect(res.body).not.toContain('abcdef1234567890');

    // 库里是密文
    const row = db.prepare("SELECT value FROM user_settings WHERE key='dingtalkWebhook'").get() as { value: string };
    expect(row.value).not.toContain('access_token=abcdef');
  });

  it('PATCH 开关 per-key upsert，互不覆盖', async () => {
    await app.inject({ method: 'PATCH', url: '/api/settings', headers: auth(), payload: { notifyStatusChange: false } });
    await app.inject({ method: 'PATCH', url: '/api/settings', headers: auth(), payload: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=x1234' } });
    const body = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).json() as {
      settings: { notifyStatusChange: boolean; webhook: { configured: boolean } };
    };
    expect(body.settings.notifyStatusChange).toBe(false);
    expect(body.settings.webhook.configured).toBe(true);
  });
});

describe('S17 token 轮换真失效', () => {
  it('轮换后旧 token 401，新 token 200', async () => {
    const old = token;
    const rot = await app.inject({ method: 'POST', url: '/api/settings/token', headers: auth() });
    expect(rot.statusCode).toBe(200);
    token = (rot.json() as { token: string }).token;

    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${old}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).statusCode).toBe(200);
  });

  it('连续轮换两次，中间 token 也失效', async () => {
    const first = (await app.inject({ method: 'POST', url: '/api/settings/token', headers: auth() })).json() as { token: string };
    token = first.token;
    const second = (await app.inject({ method: 'POST', url: '/api/settings/token', headers: auth() })).json() as { token: string };
    token = second.token;

    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${first.token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).statusCode).toBe(200);
  });
});

describe('S19 webhook 连通性测试端点', () => {
  let hookServer: Server;
  let hookUrl: string;
  let hookErrcode = 0;

  beforeEach(async () => {
    hookErrcode = 0;
    hookServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errcode: hookErrcode, errmsg: hookErrcode ? 'token is not exist' : 'ok' }));
    });
    await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/robot/send?access_token=t`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => hookServer.close(() => r()));
  });

  it('钉钉回 HTTP 200 但 errcode!=0 时判失败（不假阳性）', async () => {
    hookErrcode = 300001;
    const res = await app.inject({ method: 'POST', url: '/api/settings/webhook/test', headers: auth(), payload: { url: hookUrl } });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('token is not exist');
  });

  it('errcode=0 判成功', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/webhook/test', headers: auth(), payload: { url: hookUrl } });
    expect(res.statusCode).toBe(200);
  });
});
