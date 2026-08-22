/**
 * bots API 与凭证加密测试（spec §7 D4–D5：secret 不泄漏、CRUD、透传）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import type { OssSigner } from './oss.js';
import type { PodOrchestrator, PodPhase, SandboxPodSpec } from './k8s.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { recordSandboxCreate, recordSandboxReady, recordSandboxReclaim } from './store.js';
import type { SandboxListResp } from '@agenthub/shared';

const fakeSigner: OssSigner = {
  signPut: async (k) => `https://oss.fake/put/${k}`,
  signGet: async (k) => `https://oss.fake/get/${k}`,
};

class FakeOrchestrator implements PodOrchestrator {
  pods = new Map<string, PodPhase>();
  secrets = new Map<string, Record<string, string>>();
  async createPod(spec: SandboxPodSpec) {
    this.pods.set(spec.podName, 'ready');
    return spec.podName;
  }
  async deletePod(name: string) {
    this.pods.delete(name);
  }
  async getPodPhase(name: string): Promise<PodPhase> {
    return this.pods.get(name) ?? 'gone';
  }
  async listSandboxPods() {
    return [...this.pods.entries()].map(([name, phase]) => ({ name, phase, labels: {} }));
  }
  async createSecret(name: string, data: Record<string, string>) {
    this.secrets.set(name, data);
  }
  async deleteSecret(name: string) {
    this.secrets.delete(name);
  }
  async createDeployment(spec: SandboxPodSpec) {
    // 委托 createPod：测试覆写 createPod 即可同时模拟 Deployment 创建失败
    return await this.createPod(spec);
  }
  async deleteDeployment(name: string) {
    this.pods.delete(name);
  }
  async findPodNameByLabel(_labels: Record<string, string>): Promise<string | undefined> {
    return undefined;
  }
}

describe('crypto', () => {
  it('AES-256-GCM 加解密往返；篡改报错', () => {
    const enc = encryptSecret('ding-secret-!@#中文', 'hub-key');
    expect(enc).not.toContain('ding-secret');
    expect(decryptSecret(enc, 'hub-key')).toBe('ding-secret-!@#中文');
    expect(() => decryptSecret(enc, 'wrong-key')).toThrow();
  });
});

describe('bots API', () => {
  let db: DB;
  let app: FastifyInstance;
  let orch: FakeOrchestrator;
  let token: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    orch = new FakeOrchestrator();
    app = buildApp({
      db,
      signer: fakeSigner,
      secret: 'test-secret',
      sandbox: {
        orchestrator: orch,
        connector: { getBaseUrl: async () => 'http://127.0.0.1:1', dispose: async () => undefined },
        namespace: 'agenthub',
        image: 'test/sandbox:itest',
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
    token = (res.json() as { token: string }).token;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('创建 bot：拉起常驻 Pod + 注入钉钉 Secret；响应不含 secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'mybot', clientId: 'ding-cid', clientSecret: 'ding-cs' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('running');
    expect(JSON.stringify(body)).not.toContain('ding-cs');
    expect(orch.pods.size).toBe(1);
    expect(orch.secrets.get('bot-1')).toEqual({ DINGTALK_CLIENT_ID: 'ding-cid', DINGTALK_CLIENT_SECRET: 'ding-cs' });
    // 库里是密文
    const row = db.prepare('SELECT client_secret_enc FROM bots WHERE id=1').get() as { client_secret_enc: string };
    expect(row.client_secret_enc).not.toContain('ding-cs');
  });

  it('删除 bot：Pod 与 Secret 回收，软删后列表不可见', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'mybot', clientId: 'c', clientSecret: 's' },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/bots/1', headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(204);
    expect(orch.pods.size).toBe(0);
    expect(orch.secrets.size).toBe(0);
    const list = await app.inject({ method: 'GET', url: '/api/bots', headers: { authorization: `Bearer ${token}` } });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('创建 bot 会开一行 sandbox 历史（bot pod 不经过 Worker，由本路由维护）', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'mybot', clientId: 'c', clientSecret: 's' },
    });

    const rows = db.prepare('SELECT * FROM sandboxes').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['kind']).toBe('bot');
    expect(rows[0]!['bot_id']).toBe(1);
    expect(rows[0]!['pod_name']).toBe('ah-bot-1-mybot');
    expect(rows[0]!['image']).toBe('test/sandbox:itest');
    expect(rows[0]!['status']).toBe('running');
    expect(rows[0]!['handoff_id']).toBeNull();
  });

  it('删除 bot 关闭历史行，原因 bot-deleted', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'mybot', clientId: 'c', clientSecret: 's' },
    });

    await app.inject({ method: 'DELETE', url: '/api/bots/1', headers: { authorization: `Bearer ${token}` } });

    const row = db.prepare('SELECT * FROM sandboxes').get() as Record<string, unknown>;
    expect(row['status']).toBe('reclaimed');
    expect(row['reclaim_reason']).toBe('bot-deleted');
    expect(row['ended_at']).not.toBeNull();
  });

  it('建 Pod 失败时历史行记为 failed/pod-failed，不留悬挂的 provisioning', async () => {
    orch.createPod = async () => {
      throw new Error('quota exceeded');
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'mybot', clientId: 'c', clientSecret: 's' },
    });
    expect(res.statusCode).toBe(502);

    const row = db.prepare('SELECT * FROM sandboxes').get() as Record<string, unknown>;
    expect(row['status']).toBe('failed');
    expect(row['reclaim_reason']).toBe('pod-failed');
    expect(row['last_error']).toContain('quota exceeded');
  });

  it('kind=bot 的 handoff 必须携带本人有效 botId', async () => {
    const payload = {
      agentName: 'demo', workspacePath: '/w', wsHash: 'w-h', sessionId: 's',
      baseCommit: 'b', branch: 'main', kind: 'bot', timeoutMinutes: 30,
    };
    const noBot = await app.inject({ method: 'POST', url: '/api/handoffs', headers: { authorization: `Bearer ${token}` }, payload });
    expect(noBot.statusCode).toBe(400);
    const ghost = await app.inject({
      method: 'POST', url: '/api/handoffs', headers: { authorization: `Bearer ${token}` }, payload: { ...payload, botId: 99 },
    });
    expect(ghost.statusCode).toBe(404);
  });
});

describe('chat 代理守卫', () => {
  it('非 running / 非 web 的 handoff 走代理返回 ERR_NOT_READY', async () => {
    const db = openDb(':memory:');
    const app = buildApp({ db, signer: fakeSigner, secret: 's' });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
    const token = (reg.json() as { token: string }).token;
    const created = await app.inject({
      method: 'POST', url: '/api/handoffs', headers: { authorization: `Bearer ${token}` },
      payload: { agentName: 'd', workspacePath: '/w', wsHash: 'h', sessionId: 's', baseCommit: 'b', branch: 'm', kind: 'web', timeoutMinutes: 30 },
    });
    const id = (created.json() as { handoffId: string }).handoffId;
    const res = await app.inject({ method: 'GET', url: `/api/handoffs/${id}/chat/acp`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR_NOT_READY');
    await app.close();
    db.close();
  });
});

describe('GET /api/sandboxes（S9）', () => {
  let db: DB;
  let app: FastifyInstance;
  let orch: FakeOrchestrator;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    orch = new FakeOrchestrator();
    app = buildApp({
      db,
      signer: fakeSigner,
      secret: 'test-secret',
      sandbox: {
        orchestrator: orch,
        connector: { getBaseUrl: async () => 'http://127.0.0.1:1', dispose: async () => undefined },
        namespace: 'agenthub',
        image: 'test/sandbox:itest',
      },
    });
    const a = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
    tokenA = (a.json() as { token: string }).token;
    const b = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'bob', password: 'secret123' } });
    tokenB = (b.json() as { token: string }).token;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const get = (token: string, qs = '') =>
    app.inject({ method: 'GET', url: `/api/sandboxes${qs}`, headers: { authorization: `Bearer ${token}` } });

  it('未登录 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sandboxes' })).statusCode).toBe(401);
  });

  it('返回本人实例、模板与真实策略', async () => {
    recordSandboxCreate(db, {
      podName: 'ah-web-aaa111',
      userId: 1,
      kind: 'web',
      image: 'test/sandbox:itest',
      namespace: 'agenthub',
      handoffId: 'hf-aaa111',
    });
    recordSandboxReady(db, 'ah-web-aaa111');

    const body = (await get(tokenA)).json() as SandboxListResp;

    expect(body.configured).toBe(true);
    expect(body.windowHours).toBe(24);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.podName).toBe('ah-web-aaa111');
    expect(body.items[0]!.status).toBe('running');
    expect(body.items[0]!.handoffId).toBe('hf-aaa111');
    expect(body.stats.running).toBe(1);
    expect(body.stats.templates).toBe(1);
    // 模板信息来自 Dockerfile 登记 + 建 Pod 的真实资源规格
    expect(body.template!.image).toBe('test/sandbox:itest');
    expect(body.template!.baseImage).toBe('node:22-slim');
    expect(body.template!.resources).toEqual({ cpu: '2', memory: '4Gi' });
    expect(body.template!.ports).toEqual({ runner: 8080, serve: 8081, shellProxy: 8082, ide: 8083 });
    expect(body.template!.toolchain).toContain('git');
    expect(body.policy.defaultTimeoutMinutes).toBe(30);
    expect(body.policy.orphanIntervalMs).toBe(600_000);
  });

  it('跨用户不可见', async () => {
    recordSandboxCreate(db, { podName: 'ah-web-alice', userId: 1, kind: 'web', image: 'i', namespace: 'agenthub' });

    expect(((await get(tokenA)).json() as SandboxListResp).items).toHaveLength(1);
    expect(((await get(tokenB)).json() as SandboxListResp).items).toHaveLength(0);
    expect(((await get(tokenB)).json() as SandboxListResp).stats.running).toBe(0);
  });

  it('累计执行时长把仍在运行的实例算进去，不报 0', async () => {
    recordSandboxCreate(db, { podName: 'ah-web-live', userId: 1, kind: 'web', image: 'i', namespace: 'agenthub' });
    recordSandboxReady(db, 'ah-web-live');
    db.prepare("UPDATE sandboxes SET ready_at = datetime('now','-600 seconds')").run();

    const body = (await get(tokenA)).json() as SandboxListResp;

    expect(body.stats.execSecondsInWindow).toBeGreaterThanOrEqual(599);
    expect(body.stats.execSecondsInWindow).toBeLessThanOrEqual(601);
  });

  it('窗口外结束的实例不返回，但仍在运行的一直返回', async () => {
    recordSandboxCreate(db, { podName: 'ah-web-old', userId: 1, kind: 'web', image: 'i', namespace: 'agenthub' });
    recordSandboxReclaim(db, 'ah-web-old', 'reclaimed', 'task-done');
    db.prepare("UPDATE sandboxes SET ended_at = datetime('now','-48 hours') WHERE pod_name='ah-web-old'").run();
    recordSandboxCreate(db, { podName: 'ah-web-live', userId: 1, kind: 'web', image: 'i', namespace: 'agenthub' });

    const body = (await get(tokenA)).json() as SandboxListResp;
    expect(body.items.map((i) => i.podName)).toEqual(['ah-web-live']);

    // 放大窗口即可看到历史实例
    const wide = (await get(tokenA, '?windowHours=720')).json() as SandboxListResp;
    expect(wide.items.map((i) => i.podName).sort()).toEqual(['ah-web-live', 'ah-web-old']);
  });

  it('windowHours 非法值回落到 24 默认窗口，合法值夹在上限内', async () => {
    expect(((await get(tokenA, '?windowHours=abc')).json() as SandboxListResp).windowHours).toBe(24);
    expect(((await get(tokenA, '?windowHours=0')).json() as SandboxListResp).windowHours).toBe(24);
    expect(((await get(tokenA, '?windowHours=-5')).json() as SandboxListResp).windowHours).toBe(24);
    expect(((await get(tokenA, '?windowHours=99999')).json() as SandboxListResp).windowHours).toBe(720);
    expect(((await get(tokenA, '?windowHours=1')).json() as SandboxListResp).windowHours).toBe(1);
  });

  it('未配置编排（HUB_NO_K8S）时 configured=false、模板为 null，但策略仍可渲染', async () => {
    const bare = buildApp({ db: openDb(':memory:'), signer: fakeSigner, secret: 's' });
    const reg = await bare.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'solo', password: 'secret123' } });
    const t = (reg.json() as { token: string }).token;

    const body = (
      await bare.inject({ method: 'GET', url: '/api/sandboxes', headers: { authorization: `Bearer ${t}` } })
    ).json() as SandboxListResp;

    expect(body.configured).toBe(false);
    expect(body.template).toBeNull();
    expect(body.stats.templates).toBe(0);
    expect(body.policy.idleTtlMinutes).toBe(120);
    await bare.close();
  });
});
