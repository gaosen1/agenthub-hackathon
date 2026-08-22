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
}

export const state: RunnerState = {
  mode: (process.env.RUNNER_MODE === 'bot' ? 'bot' : 'web'),
  serveReady: false,
  taskDone: false,
  ideReady: false,
  loading: false,
};

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
