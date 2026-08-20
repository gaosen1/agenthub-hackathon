/**
 * 设置面板数据（S19）。GET/PATCH /api/settings、token 轮换、webhook 连通性测试。
 */
import { SettingsRespSchema, type SettingsResp } from '@agenthub/shared/contracts';
import { hubFetch } from './client.js';

export async function fetchSettings(): Promise<SettingsResp> {
  return hubFetch('/api/settings', (d) => SettingsRespSchema.parse(d));
}

export async function patchSettings(body: {
  notifyStatusChange?: boolean;
  notifyChatSync?: boolean;
  webhook?: string | null;
}): Promise<void> {
  await hubFetch('/api/settings', () => undefined, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 轮换 API token；返回新 token，调用方必须立刻落 localStorage 以免把自己踢下线 */
export async function rotateToken(): Promise<string> {
  const { token } = await hubFetch('/api/settings/token', (d) => d as { token: string }, { method: 'POST' });
  return token;
}

export async function testWebhook(url?: string): Promise<void> {
  await hubFetch('/api/settings/webhook/test', (d) => d as { ok: boolean }, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(url ? { url } : {}),
  });
}
