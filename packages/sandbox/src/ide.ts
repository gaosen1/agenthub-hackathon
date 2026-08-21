/**
 * Web IDE（code-server）按需拉起：二进制预置在 NAS 共享只读层 /mnt/shared，
 * 首次 ensure 时 spawn 监听 :8082，Pod 生命周期内幂等复用。
 */
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { RunnerIdeStatusResp } from '@agenthub/shared';
import { appendLog, state } from './state.js';

export const IDE_PORT = Number(process.env.IDE_PORT ?? 8082);

/** NAS 挂载点（与 hub-server k8s.NAS_MOUNT_PATH 对齐，本地联调可覆盖） */
export const sharedDir = (): string => process.env.SHARED_DIR ?? '/mnt/shared';

/** seed Job 约定的目录布局：<shared>/tools/code-server/<version>/ + current 软链 */
export const codeServerBin = (): string => join(sharedDir(), 'tools', 'code-server', 'current', 'bin', 'code-server');

let proc: ChildProcess | undefined;
let lastError: string | undefined;

/** 依赖注入点：测试替换 spawn/探测实现，避免真起进程 */
export const ideDeps = {
  exists: (p: string): boolean => existsSync(p),
  spawn,
  probeReady: async (port: number): Promise<boolean> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  },
};

export function codeServerInstalled(): boolean {
  return ideDeps.exists(codeServerBin());
}

/** 仅测试用：复位模块级进程状态 */
export function resetIdeForTest(): void {
  proc = undefined;
  lastError = undefined;
  state.ideReady = false;
}

export function ideStatus(): RunnerIdeStatusResp {
  const alive = proc !== undefined && proc.exitCode === null;
  return {
    ready: alive,
    ...(alive && proc?.pid ? { pid: proc.pid } : {}),
    ...(lastError ? { error: lastError } : {}),
  };
}

/** 幂等拉起 code-server 打开 workspacePath；已存活直接返回 ready */
export async function ensureIde(workspacePath: string): Promise<RunnerIdeStatusResp> {
  const cur = ideStatus();
  if (cur.ready) return cur;
  if (!codeServerInstalled()) {
    lastError = 'code-server not installed on shared layer';
    return { ready: false, error: lastError };
  }

  lastError = undefined;
  const child = ideDeps.spawn(
    codeServerBin(),
    [
      '--bind-addr',
      `0.0.0.0:${IDE_PORT}`,
      '--auth',
      'none',
      '--disable-workspace-trust',
      '--disable-telemetry',
      '--disable-update-check',
      workspacePath,
    ],
    { detached: true, stdio: 'ignore' },
  );
  proc = child;
  child.unref();
  child.on('exit', (code) => {
    appendLog(code === 0 ? 'sys' : 'err', `code-server exited (code ${code})`);
    if (proc === child) {
      proc = undefined;
      state.ideReady = false;
    }
  });
  appendLog('sys', `code-server starting on :${IDE_PORT} for ${workspacePath} (pid ${child.pid ?? '?'})`);

  // code-server 冷启动需数秒，轮询 /healthz 直至就绪
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      lastError = `code-server exited early (code ${child.exitCode})`;
      appendLog('err', lastError);
      if (proc === child) proc = undefined;
      return { ready: false, error: lastError };
    }
    if (await ideDeps.probeReady(IDE_PORT)) {
      state.ideReady = true;
      appendLog('ok', 'code-server ready');
      return { ready: true, ...(child.pid ? { pid: child.pid } : {}) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  lastError = 'code-server did not become ready within 20s';
  appendLog('err', lastError);
  return { ready: false, error: lastError };
}
