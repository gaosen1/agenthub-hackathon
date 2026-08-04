/**
 * Hub REST 客户端（spec §4.2）+ mock 回退
 * - Hub 可达且已登录 → 真实数据（dataSource='hub'）
 * - Hub 可达但 401 → 提示登录（dataSource='unauth'），不回退 mock
 * - Hub 不可达（网络错误）→ 回退 mock 数据（dataSource='mock'），组件层无感知
 */
import {
  ApiErrorSchema,
  AuthRespSchema,
  HandoffDetailSchema,
  HandoffEventsRespSchema,
  ListHandoffsRespSchema,
} from '@agenthub/shared/contracts';
import type { AuthResp, HandoffDetail, HandoffEventsResp, ListHandoffsResp } from '@agenthub/shared/contracts';
import { mockDetails, mockSummaries } from './mock.js';

export type DataSource = 'hub' | 'mock' | 'unauth';
/** 数据来源标记：Topbar 连接指示用（随轮询刷新） */
export let dataSource: DataSource = 'mock';

const TOKEN_KEY = 'agenthub_token';
export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

class AuthRequiredError extends Error {
  constructor() {
    super('未登录或 token 失效');
  }
}

async function hubFetch<T>(path: string, parse: (d: unknown) => T, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  const t = getToken();
  if (t) headers['authorization'] = `Bearer ${t}`;
  const resp = await fetch(path, { ...init, headers });
  if (resp.status === 401) throw new AuthRequiredError();
  if (!resp.ok) {
    const err = ApiErrorSchema.safeParse(await resp.json().catch(() => undefined));
    throw new Error(err.success ? err.data.error.message : `HTTP ${resp.status}`);
  }
  return parse(await resp.json());
}

// ---------- auth ----------

export async function login(username: string, password: string, register = false): Promise<AuthResp> {
  const resp = await fetch(`/api/auth/${register ? 'register' : 'login'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data: unknown = await resp.json().catch(() => undefined);
  if (!resp.ok) {
    const err = ApiErrorSchema.safeParse(data);
    throw new Error(err.success ? err.data.error.message : `HTTP ${resp.status}`);
  }
  const auth = AuthRespSchema.parse(data);
  localStorage.setItem(TOKEN_KEY, auth.token);
  dataSource = 'hub';
  return auth;
}

// ---------- handoffs ----------

export async function fetchHandoffs(): Promise<ListHandoffsResp> {
  try {
    const data = await hubFetch('/api/handoffs', (d) => ListHandoffsRespSchema.parse(d));
    dataSource = 'hub';
    return data;
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      dataSource = 'unauth';
      return { items: [] };
    }
    dataSource = 'mock';
    return { items: mockSummaries };
  }
}

export async function fetchHandoffDetail(id: string): Promise<HandoffDetail> {
  try {
    const data = await hubFetch(`/api/handoffs/${id}`, (d) => HandoffDetailSchema.parse(d));
    dataSource = 'hub';
    return data;
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    dataSource = 'mock';
    const detail = mockDetails[id];
    if (!detail) throw new Error(`handoff ${id} 不存在`);
    return detail;
  }
}

export async function fetchHandoffEvents(id: string, after = 0): Promise<HandoffEventsResp> {
  try {
    return await hubFetch(`/api/handoffs/${id}/events?after=${after}`, (d) => HandoffEventsRespSchema.parse(d));
  } catch {
    return { items: [], nextAfter: after };
  }
}

export async function cancelHandoff(id: string): Promise<void> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers['authorization'] = `Bearer ${t}`;
  await fetch(`/api/handoffs/${id}/cancel`, { method: 'POST', headers });
}

/** 交互接力收尾：pull-intent 在 running 时触发 packaging（409 是预期应答，轮询详情等终态） */
export async function finishHandoff(id: string): Promise<void> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers['authorization'] = `Bearer ${t}`;
  await fetch(`/api/handoffs/${id}/pull-intent`, { method: 'POST', headers }).catch(() => undefined);
}
