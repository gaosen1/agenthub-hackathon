/**
 * Sandbox 面板数据（GET /api/sandboxes）。沿用 client.ts 的 hubFetch 语义：
 * 401 抛 AuthRequiredError，其他错误交给 react-query 处理。
 *
 * 与 handoff 列表不同，这里**不做 mock 回退**——面板宁可显示未配置/加载失败，
 * 也不能拿假数据冒充真实的云端实例。
 */
import { SandboxListRespSchema, type SandboxListResp } from '@agenthub/shared/contracts';
import { hubFetch } from './client.js';

export async function fetchSandboxes(windowHours = 24): Promise<SandboxListResp> {
  return hubFetch(`/api/sandboxes?windowHours=${windowHours}`, (d) => SandboxListRespSchema.parse(d));
}
