/**
 * Web IDE 代理集成测试：ensure 下发 Cookie / 剥前缀转发 / Location 重写 /
 * Cookie 鉴权 / 根逃逸 302 兜底 / WebSocket upgrade 打通。
 * 替身：K8s（FakeOrchestrator）+ runner（/ide/ensure）+ code-server（HTTP+WS）。
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import type { OssSigner } from './oss.js';
import type { PodOrchestrator, PodPhase, SandboxPodSpec } from './k8s.js';
import type { PodRef, SandboxConnector } from './connector.js';

const fakeSigner: OssSigner = {
  signPut: async (k) => `https://oss.fake/put/${k}`,
  signGet: async (k) => `https://oss.fake/get/${k}`,
};

class FakeOrchestrator implements PodOrchestrator {
  async createPod(_spec: SandboxPodSpec): Promise<void> {}
  async deletePod(_name: string): Promise<void> {}
  async getPodPhase(_name: string): Promise<PodPhase> {
    return 'ready';
  }
  async listSandboxPods() {
    return [];
  }
  async createSecret(_name: string, _data: Record<string, string>): Promise<void> {}
  async deleteSecret(_name: string): Promise<void> {}
  async createDeployment(spec: SandboxPodSpec): Promise<void> {
    await this.createPod(spec);
  }
  async deleteDeployment(_name: string): Promise<void> {}
  async findPodNameByLabel(_labels: Record<string, string>): Promise<string | undefined> {
    return undefined;
  }
}

let db: DB;
let app: FastifyInstance;
let runnerServer: Server;
let ideServer: Server;
let runnerUrl: string;
let ideUrl: string;
/** runner /ide/ensure 的应答开关：200 就绪 / 409 未安装 */
let runnerEnsureStatus = 200;
let token: string;
let hid: string;
let ideCookie: string;

const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });

beforeEach(async () => {
  runnerEnsureStatus = 200;

  // fake runner（:8080 替身）：只实现 /ide/ensure
  runnerServer = createServer((req, res) => {
    if (req.url === '/ide/ensure' && req.method === 'POST') {
      if (runnerEnsureStatus === 200) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ready: true, pid: 777 }));
      } else {
        res.writeHead(409, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: { code: 'ERR_NOT_READY', message: 'code-server not preinstalled on shared layer' } }),
        );
      }
      return;
    }
    res.writeHead(404).end();
  });
  runnerUrl = await listen(runnerServer);

  // fake code-server（:8082 替身）：回显请求路径；/redir 根绝对跳转；支持 upgrade
  ideServer = createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { location: '/login' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ url: req.url, host: req.headers.host }));
  });
  ideServer.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n');
    socket.write('ide-ws-hello');
    // 写完即关：避免长连接挂住 afterEach 的 app.close()
    socket.end();
  });
  ideUrl = await listen(ideServer);

  db = openDb(':memory:');
  const connector: SandboxConnector = {
    getBaseUrl: async (_pod: PodRef, port: number) => (port === 8080 ? runnerUrl : ideUrl),
    invalidate: () => undefined,
    dispose: async () => undefined,
  };
  app = buildApp({
    db,
    signer: fakeSigner,
    secret: 'test-secret',
    sandbox: { connector, orchestrator: new FakeOrchestrator(), namespace: 'agenthub' },
  });

  // 造一个 running 的 web handoff（绕过 Worker，直接改库模拟云端已起 Pod）
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
  token = (reg.json() as { token: string }).token;
  const created = await app.inject({
    method: 'POST',
    url: '/api/handoffs',
    headers: { authorization: `Bearer ${token}` },
    payload: { agentName: 'demo', workspacePath: '/x', wsHash: 'h-abc123def456', sessionId: 's', baseCommit: 'c', branch: 'main', kind: 'web' },
  });
  hid = (created.json() as { handoffId: string }).handoffId;
  db.prepare("UPDATE handoffs SET status='running', pod_name='ah-web-abc123', runner_token='rt-1' WHERE id=?").run(hid);

  const ensured = await app.inject({
    method: 'POST',
    url: `/api/handoffs/${hid}/ide/ensure`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(ensured.statusCode).toBe(200);
  const setCookie = String(ensured.headers['set-cookie'] ?? '');
  expect(setCookie).toContain('ah_ide=');
  expect(setCookie).toContain('HttpOnly');
  ideCookie = setCookie.split(';')[0]!.split('=').slice(1).join('=');
});

afterEach(async () => {
  await app.close();
  db.close();
  runnerServer.close();
  ideServer.close();
});

describe('POST /api/handoffs/:id/ide/ensure', () => {
  it('就绪时下发 runner 状态与 IDE Cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/handoffs/${hid}/ide/ensure`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, pid: 777 });
  });

  it('runner 报未安装（409）时透传为 ERR_NOT_READY', async () => {
    runnerEnsureStatus = 409;
    const res = await app.inject({
      method: 'POST',
      url: `/api/handoffs/${hid}/ide/ensure`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR_NOT_READY');
  });
});

describe('IDE 透明反代', () => {
  it('剥前缀转发上游，host 换为上游地址', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/handoffs/${hid}/ide/static/app.js?v=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: '/static/app.js?v=1' });
    expect((res.json() as { host: string }).host).not.toContain('localhost');
  });

  it('Cookie 鉴权可用；无凭证 401', async () => {
    const withCookie = await app.inject({ method: 'GET', url: `/api/handoffs/${hid}/ide/`, headers: { cookie: `ah_ide=${ideCookie}` } });
    expect(withCookie.statusCode).toBe(200);
    const anon = await app.inject({ method: 'GET', url: `/api/handoffs/${hid}/ide/` });
    expect(anon.statusCode).toBe(401);
  });

  it('上游根绝对 Location 重写为带前缀路径', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/handoffs/${hid}/ide/redir`,
      headers: { cookie: `ah_ide=${ideCookie}` },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/api/handoffs/${hid}/ide/login`);
  });

  it('根逃逸请求带活跃 Cookie 时 302 回前缀路径', async () => {
    const res = await app.inject({ method: 'GET', url: '/static/x.js', headers: { cookie: `ah_ide=${ideCookie}` } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/api/handoffs/${hid}/ide/static/x.js`);
  });
});

describe('WebSocket upgrade', () => {
  it('经 Hub 代理与上游 code-server 完成 101 握手并透传数据', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const got = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: `/api/handoffs/${hid}/ide/ws?reconnectionToken=t`,
        method: 'GET',
        agent: false,
        headers: { connection: 'upgrade', upgrade: 'websocket', cookie: `ah_ide=${ideCookie}` },
      });
      req.on('upgrade', (res, socket, head) => {
        if (res.statusCode !== 101) return reject(new Error(`upgrade status ${res.statusCode}`));
        // 与 101 同段到达的数据在 head 里，后续帧才走 data
        if (head.length > 0) {
          socket.destroy();
          return resolve(head.toString());
        }
        socket.once('data', (chunk) => {
          socket.destroy();
          resolve(chunk.toString());
        });
      });
      req.on('response', (res) => reject(new Error(`no upgrade, got HTTP ${res.statusCode}`)));
      req.on('socket', (s) => s.on('close', () => reject(new Error('socket closed before upgrade'))));
      req.on('error', reject);
      req.end();
    });
    expect(got).toBe('ide-ws-hello');
  });
});
