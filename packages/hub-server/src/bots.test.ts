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

const fakeSigner: OssSigner = {
  signPut: async (k) => `https://oss.fake/put/${k}`,
  signGet: async (k) => `https://oss.fake/get/${k}`,
};

class FakeOrchestrator implements PodOrchestrator {
  pods = new Map<string, PodPhase>();
  secrets = new Map<string, Record<string, string>>();
  async createPod(spec: SandboxPodSpec) {
    this.pods.set(spec.podName, 'ready');
  }
  async deletePod(name: string) {
    this.pods.delete(name);
  }
  async getPodPhase(name: string): Promise<PodPhase> {
    return this.pods.get(name) ?? 'gone';
  }
  async listSandboxPodNames() {
    return [...this.pods.keys()];
  }
  async createSecret(name: string, data: Record<string, string>) {
    this.secrets.set(name, data);
  }
  async deleteSecret(name: string) {
    this.secrets.delete(name);
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
