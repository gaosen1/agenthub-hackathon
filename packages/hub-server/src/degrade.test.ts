/**
 * 降级矩阵（S22）：{无 OSS 凭证} × {HUB_NO_K8S/无 sandbox} × {未登录}
 * 每个面板端点都要返回合理空态：不能 500、不能假数据。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import { createOssClient } from './oss.js';
import type { OssListResp } from '@agenthub/shared';

const ENV = ['OSS_BUCKET', 'OSS_AK', 'OSS_SK', 'OSS_REGION', 'HUB_NO_OSS'] as const;
let saved: Record<string, string | undefined>;
let db: DB;
let app: FastifyInstance;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  db = openDb(':memory:');
  // 无 sandbox 依赖 + NullOssClient：最降级装配
  app = buildApp({ db, signer: createOssClient(), secret: 's' });
});

afterEach(async () => {
  await app.close();
  db.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('降级矩阵（S22）', () => {
  it('未登录：所有面板端点 401，不泄漏结构', async () => {
    for (const url of ['/api/sandboxes', '/api/oss', '/api/settings']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('无 OSS × 无编排：三个面板都返回 configured=false 的空态，refresh 不炸', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'solo', password: 'secret123' } });
    const token = (reg.json() as { token: string }).token;
    const auth = { authorization: `Bearer ${token}` };

    const sb = await app.inject({ method: 'GET', url: '/api/sandboxes', headers: auth });
    expect(sb.statusCode).toBe(200);
    const sbBody = sb.json() as { configured: boolean; items: unknown[]; policy: { idleTtlMinutes: number } };
    expect(sbBody.configured).toBe(false);
    expect(sbBody.items).toEqual([]);
    expect(sbBody.policy.idleTtlMinutes).toBe(30);

    const oss = await app.inject({ method: 'GET', url: '/api/oss?refresh=1', headers: auth });
    expect(oss.statusCode).toBe(200);
    const ossBody = oss.json() as OssListResp;
    expect(ossBody.configured).toBe(false);
    expect(ossBody.items).toEqual([]);
    expect(ossBody.stats.totalBytes).toBe(0);

    const st = await app.inject({ method: 'GET', url: '/api/settings', headers: auth });
    expect(st.statusCode).toBe(200);
    const stBody = st.json() as { settings: { webhook: { configured: boolean } }; server: { ossBucket: string | null } };
    expect(stBody.settings.webhook.configured).toBe(false);
    expect(stBody.server.ossBucket).toBeNull();
  });

  it('未配置 OSS 时签名请求报 ERR_OSS 而不是返回垃圾 URL', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'solo', password: 'secret123' } });
    const token = (reg.json() as { token: string }).token;
    const res = await app.inject({
      method: 'POST',
      url: '/api/oss/sign',
      headers: { authorization: `Bearer ${token}` },
      payload: { key: 'handoffs/1/hf-x/input.tar.gz' },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).toContain('ERR_OSS');
  });
});
