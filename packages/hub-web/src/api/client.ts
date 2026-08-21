/**
 * Hub REST 客户端（spec §4.2）+ mock 回退
 * - Hub 可达且已登录 → 真实数据（dataSource='hub'）
 * - Hub 可达但 401 → 提示登录（dataSource='unauth'），不回退 mock
 * - Hub 不可达（网络错误）→ 回退 mock 数据（dataSource='mock'），组件层无感知
 */
import {
  ApiErrorSchema,
  AuthRespSchema,
  BotSchema,
  HandoffDetailSchema,
  HandoffEventsRespSchema,
  ListHandoffsRespSchema,
  RunnerIdeStatusRespSchema,
} from '@agenthub/shared/contracts';
import type { AuthResp, Bot, HandoffDetail, HandoffEventsResp, ListHandoffsResp, RunnerIdeStatusResp } from '@agenthub/shared/contracts';
import { useSyncExternalStore } from 'react';
import { mockDetails, mockSummaries } from './mock.js';

export type DataSource = 'hub' | 'mock' | 'unauth';

/**
 * 数据来源标记：Topbar 连接指示 + 各视图空态文案。
 * 用可订阅的外部 store 而非裸模块变量——否则登录成功后 Hub 返回的空列表
 * 与 401 分支的空列表深相等，TanStack Query 不触发 re-render，UI 会卡在旧文案。
 */
let dataSource: DataSource = 'mock';
const dsListeners = new Set<() => void>();
export const getDataSource = (): DataSource => dataSource;
export function setDataSource(next: DataSource): void {
  if (dataSource === next) return;
  dataSource = next;
  dsListeners.forEach((l) => l());
}
export function useDataSource(): DataSource {
  return useSyncExternalStore(
    (cb) => {
      dsListeners.add(cb);
      return () => dsListeners.delete(cb);
    },
    getDataSource,
  );
}

const TOKEN_KEY = 'agenthub_token';
export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const saveToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export class AuthRequiredError extends Error {
  constructor() {
    super('未登录或 token 失效');
  }
}

/** 带 Bearer 的 JSON 请求；401 抛 AuthRequiredError。三个面板的 api 模块共用。 */
export async function hubFetch<T>(path: string, parse: (d: unknown) => T, init?: RequestInit): Promise<T> {
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
  setDataSource('hub');
  return auth;
}

// ---------- handoffs ----------

export async function fetchHandoffs(archived = false): Promise<ListHandoffsResp> {
  try {
    const data = await hubFetch(`/api/handoffs${archived ? '?archived=1' : ''}`, (d) => ListHandoffsRespSchema.parse(d));
    setDataSource('hub');
    return data;
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      setDataSource('unauth');
      return { items: [] };
    }
    setDataSource('mock');
    return { items: mockSummaries };
  }
}

/** 归档/取消归档（仅终态；非终态服务端 409） */
export async function archiveHandoff(id: string, archived: boolean): Promise<void> {
  await hubFetch(`/api/handoffs/${id}/archive`, () => undefined, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
}

export async function deleteHandoff(id: string): Promise<void> {
  await hubFetch(`/api/handoffs/${id}`, () => undefined, { method: 'DELETE' });
}

export async function fetchHandoffDetail(id: string): Promise<HandoffDetail> {
  try {
    const data = await hubFetch(`/api/handoffs/${id}`, (d) => HandoffDetailSchema.parse(d));
    setDataSource('hub');
    return data;
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    setDataSource('mock');
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

// ---------- Web IDE (code-server) ----------

/** 拉起沙箱内的 code-server；成功后服务端下发 IDE Cookie，iframe 代理请求靠它鉴权 */
export async function ensureIde(handoffId: string): Promise<RunnerIdeStatusResp> {
  return hubFetch(`/api/handoffs/${handoffId}/ide/ensure`, (d) => RunnerIdeStatusRespSchema.parse(d), { method: 'POST' });
}

/** IDE iframe 入口：代理路径前缀，Cookie 随同源请求自动携带 */
export const ideProxyUrl = (handoffId: string): string => `/api/handoffs/${handoffId}/ide/`;

// ---------- model config (per-user) ----------

export interface ModelConfig {
  hasKey: boolean;
  baseUrl?: string;
  model?: string;
}

export async function getModelConfig(): Promise<ModelConfig> {
  return hubFetch('/api/account/model', (d) => d as ModelConfig);
}

export async function setModelConfig(apiKey: string, baseUrl: string, model: string): Promise<void> {
  await hubFetch('/api/account/model', () => undefined, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, baseUrl, model }),
  });
}

// ---------- bots (钉钉机器人) ----------

export async function fetchBots(): Promise<Bot[]> {
  const data = await hubFetch('/api/bots', (d) => d as { items: unknown[] });
  return data.items.map((b) => BotSchema.parse(b));
}

export async function createBot(name: string, clientId: string, clientSecret: string): Promise<Bot> {
  return hubFetch('/api/bots', (d) => BotSchema.parse(d), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, clientId, clientSecret }),
  });
}

export async function deleteBot(id: number): Promise<void> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers['authorization'] = `Bearer ${t}`;
  const resp = await fetch(`/api/bots/${id}`, { method: 'DELETE', headers });
  if (!resp.ok && resp.status !== 204) {
    const err = ApiErrorSchema.safeParse(await resp.json().catch(() => undefined));
    throw new Error(err.success ? err.data.error.message : `HTTP ${resp.status}`);
  }
}
