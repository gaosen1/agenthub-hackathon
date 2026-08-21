/**
 * OSS 存储面板（S12–S14）：元数据落库、纯 SQL 出数据、签名归属校验、?refresh=1 对账。
 * 验收：head 失败不致命；他人 key / 路径穿越 → 403；未配置时 refresh 为 no-op。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import type { BucketInfo, OssClient, OssObject } from './oss.js';
import type { OssListResp } from '@agenthub/shared';

class FakeOss implements OssClient {
  readonly configured = true;
  objects = new Map<string, OssObject>();
  headError = false;

  async signPut(k: string) {
    return `https://oss.fake/put/${k}`;
  }
  async signGet(k: string) {
    return `https://oss.fake/get/${k}`;
  }
  async list(prefix: string) {
    return { objects: [...this.objects.values()].filter((o) => o.key.startsWith(prefix)), truncated: false };
  }
  async deleteObject(k: string) {
    this.objects.delete(k);
  }
  async head(k: string) {
    if (this.headError) throw new Error('oss flap');
    return this.objects.get(k) ?? null;
  }
  async bucketInfo(): Promise<BucketInfo> {
    return { bucket: 'b', region: 'oss-cn-hangzhou', lifecycleDays: 7 };
  }
}

let db: DB;
let app: FastifyInstance;
let oss: FakeOss;
let token: string;

beforeEach(async () => {
  db = openDb(':memory:');
  oss = new FakeOss();
  app = buildApp({ db, signer: oss, secret: 's' });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
  token = (reg.json() as { token: string }).token;
});

afterEach(async () => {
  await app.close();
  db.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function createHandoff(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/handoffs',
    headers: auth(),
    payload: {
      agentName: 'demo',
      workspacePath: '/w',
      wsHash: 'h',
      sessionId: 's',
      baseCommit: 'b',
      branch: 'main',
      kind: 'web',
      timeoutMinutes: 30,
    },
  });
  return (res.json() as { handoffId: string }).handoffId;
}

describe('S12 元数据落库', () => {
  it('uploaded 时 head 落 input_size/uploaded_at', async () => {
    const id = await createHandoff();
    oss.objects.set(`handoffs/1/${id}/input.tar.gz`, { key: `handoffs/1/${id}/input.tar.gz`, size: 123, lastModified: '2026-08-20T01:00:00Z' });

    const up = await app.inject({ method: 'POST', url: `/api/handoffs/${id}/uploaded`, headers: auth() });
    expect(up.statusCode).toBe(200);

    const row = db.prepare('SELECT input_size, input_uploaded_at FROM handoffs WHERE id=?').get(id) as {
      input_size: number;
      input_uploaded_at: string;
    };
    expect(row.input_size).toBe(123);
    expect(row.input_uploaded_at).toBe('2026-08-20T01:00:00Z');
  });

  it('head 失败不致命：uploaded 仍 200，size 保持 NULL', async () => {
    const id = await createHandoff();
    oss.headError = true;

    const up = await app.inject({ method: 'POST', url: `/api/handoffs/${id}/uploaded`, headers: auth() });
    expect(up.statusCode).toBe(200);

    const row = db.prepare('SELECT input_size FROM handoffs WHERE id=?').get(id) as { input_size: number | null };
    expect(row.input_size).toBeNull();
  });
});

describe('S13 GET /api/oss + POST /api/oss/sign', () => {
  it('未登录 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/oss' })).statusCode).toBe(401);
  });

  it('纯 SQL 出 items 与 stats，lifecycleDays 来自 bucketInfo', async () => {
    const id = await createHandoff();
    oss.objects.set(`handoffs/1/${id}/input.tar.gz`, { key: `handoffs/1/${id}/input.tar.gz`, size: 100, lastModified: new Date().toISOString() });
    await app.inject({ method: 'POST', url: `/api/handoffs/${id}/uploaded`, headers: auth() });

    const body = (await app.inject({ method: 'GET', url: '/api/oss', headers: auth() })).json() as OssListResp;
    expect(body.configured).toBe(true);
    expect(body.lifecycleDays).toBe(7);
    expect(body.signedUrlTtlSeconds).toBe(1800);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.direction).toBe('input');
    expect(body.items[0]!.size).toBe(100);
    expect(body.items[0]!.expired).toBe(false);
    expect(body.stats.totalBytes).toBe(100);
    expect(body.stats.objectCount).toBe(1);
    expect(body.stats.uploadedToday).toBe(1);
  });

  it('签名：他人 key 403、路径穿越 403、本人 key 返回 url', async () => {
    const other = await app.inject({ method: 'POST', url: '/api/oss/sign', headers: auth(), payload: { key: 'handoffs/2/hf-x/input.tar.gz' } });
    expect(other.statusCode).toBe(403);
    const trav = await app.inject({ method: 'POST', url: '/api/oss/sign', headers: auth(), payload: { key: 'handoffs/1/../2/x' } });
    expect(trav.statusCode).toBe(403);
    const own = await app.inject({ method: 'POST', url: '/api/oss/sign', headers: auth(), payload: { key: 'handoffs/1/hf-x/input.tar.gz' } });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { url: string }).url).toContain('/get/handoffs/1/hf-x/input.tar.gz');
  });
});

describe('S14 ?refresh=1 对账', () => {
  it('未配置时 refresh 为 no-op 且 200', async () => {
    // 无凭证环境 → NullOssClient（测试不加载 .env）
    const { createOssClient } = await import('./oss.js');
    const nullOss = createOssClient();
    const db2 = openDb(':memory:');
    const app2 = buildApp({ db: db2, signer: nullOss, secret: 's' });
    const reg = await app2.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'solo', password: 'secret123' } });
    const t = (reg.json() as { token: string }).token;

    const res = await app2.inject({ method: 'GET', url: '/api/oss?refresh=1', headers: { authorization: `Bearer ${t}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OssListResp;
    expect(body.configured).toBe(false);
    expect(body.items).toEqual([]);
    await app2.close();
    db2.close();
  });

  it('list 缺失的对象标 expired，存在的补缺失 size', async () => {
    const id = await createHandoff();
    const inKey = `handoffs/1/${id}/input.tar.gz`;
    const outKey = `handoffs/1/${id}/output.tar.gz`;
    oss.objects.set(inKey, { key: inKey, size: 55, lastModified: '2026-08-20T02:00:00Z' });
    await app.inject({ method: 'POST', url: `/api/handoffs/${id}/uploaded`, headers: auth() });
    // 模拟 snapshot 已登记 output key 但镜像无 size
    db.prepare('UPDATE handoffs SET output_oss_key=? WHERE id=?').run(outKey, id);

    const res = await app.inject({ method: 'GET', url: '/api/oss?refresh=1', headers: auth() });
    const body = res.json() as OssListResp;
    const input = body.items.find((i) => i.direction === 'input')!;
    const output = body.items.find((i) => i.direction === 'output')!;
    expect(input.expired).toBe(false);
    expect(input.size).toBe(55);
    expect(output.expired).toBe(true);
    // expired 对象不计入统计
    expect(body.stats.objectCount).toBe(1);
    expect(body.stats.totalBytes).toBe(55);
  });
});
