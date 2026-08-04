/**
 * Hub REST 客户端（spec §4.2）+ mock 回退
 * 真 Hub 可达时走 /api（vite 代理 → hub-server:3000）；失败回退 mock 数据，
 * 组件层无感知——CP-3 联调时不需要改任何组件代码。
 */
import {
  HandoffDetailSchema,
  HandoffEventsRespSchema,
  ListHandoffsRespSchema,
} from '@agenthub/shared/contracts';
import type { HandoffDetail, HandoffEventsResp, ListHandoffsResp } from '@agenthub/shared/contracts';
import { mockDetails, mockSummaries } from './mock.js';

/** 数据来源标记：Topbar 连接指示用 */
export let dataSource: 'hub' | 'mock' = 'mock';

const token = (): string | null => localStorage.getItem('agenthub_token');

async function hubFetch<T>(path: string, parse: (d: unknown) => T): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers['authorization'] = `Bearer ${t}`;
  const resp = await fetch(path, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return parse(await resp.json());
}

export async function fetchHandoffs(): Promise<ListHandoffsResp> {
  try {
    const data = await hubFetch('/api/handoffs', (d) => ListHandoffsRespSchema.parse(d));
    dataSource = 'hub';
    return data;
  } catch {
    dataSource = 'mock';
    return { items: mockSummaries };
  }
}

export async function fetchHandoffDetail(id: string): Promise<HandoffDetail> {
  try {
    const data = await hubFetch(`/api/handoffs/${id}`, (d) => HandoffDetailSchema.parse(d));
    dataSource = 'hub';
    return data;
  } catch {
    dataSource = 'mock';
    const detail = mockDetails[id];
    if (!detail) throw new Error(`handoff ${id} 不存在`);
    return detail;
  }
}

export async function fetchHandoffEvents(id: string, after: number): Promise<HandoffEventsResp> {
  try {
    const data = await hubFetch(`/api/handoffs/${id}/events?after=${after}`, (d) =>
      HandoffEventsRespSchema.parse(d),
    );
    dataSource = 'hub';
    return data;
  } catch {
    dataSource = 'mock';
    return { items: [], nextAfter: after };
  }
}

export async function cancelHandoff(id: string): Promise<void> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers['authorization'] = `Bearer ${t}`;
  await fetch(`/api/handoffs/${id}/cancel`, { method: 'POST', headers });
}
