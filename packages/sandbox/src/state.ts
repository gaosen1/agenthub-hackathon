/**
 * runner 运行时状态与结构化日志（spec §3.6）
 */
import type { SandboxEvent } from '@agenthub/shared';

export interface RunnerState {
  mode: 'web' | 'bot';
  serveReady: boolean;
  taskDone: boolean;
  /** Web IDE（code-server）是否已就绪，进程句柄在 ide.ts */
  ideReady: boolean;
  loadedHandoffId?: string;
  /** 已加载工作区（/ide/ensure 需要） */
  workspacePath?: string;
  lastError?: string;
  loading: boolean;
  /** runner 控制面最近活动时间（ISO）；钉钉直达的会话活动由 healthz 从 session 文件 mtime 补齐 */
  lastActivityAt?: string;
}

export const state: RunnerState = {
  mode: (process.env.RUNNER_MODE === 'bot' ? 'bot' : 'web'),
  serveReady: false,
  taskDone: false,
  ideReady: false,
  loading: false,
};

/** 控制面活动打点（/load / /bind / /snapshot / task 终态等）：bot 驻留期空闲 TTL 的 hub 侧判据 */
export function touchActivity(): void {
  state.lastActivityAt = new Date().toISOString();
}

const logs: SandboxEvent[] = [];

export function appendLog(tag: SandboxEvent['tag'], c: string): void {
  logs.push({ t: new Date().toISOString(), tag, c });
  if (logs.length > 5000) logs.splice(0, logs.length - 5000);
}

export function logsAfter(after: number): { items: Array<SandboxEvent & { i: number }>; nextAfter: number } {
  const items = logs.slice(after).map((e, idx) => ({ ...e, i: after + idx + 1 }));
  return { items, nextAfter: after + items.length };
}

export function allLogs(): SandboxEvent[] {
  return [...logs];
}
