/**
 * qwen 进程管理：serve 子进程（可停/重启）+ 任务 headless 续跑
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendLog } from './state.js';

const QWEN_BIN = process.env.QWEN_BIN ?? 'qwen';

export interface ServeSpec {
  mode: 'web' | 'bot';
  workspacePath: string;
  botName?: string;
  serveToken?: string;
}

let serveProc: ChildProcess | null = null;

export function serveArgs(spec: ServeSpec): string[] {
  if (spec.mode === 'bot') {
    return ['serve', '--workspace', spec.workspacePath, '--channel', spec.botName ?? ''];
  }
  return ['serve', '--hostname', '0.0.0.0', '--port', '8081', '--workspace', spec.workspacePath];
}

export async function startServe(spec: ServeSpec): Promise<void> {
  await stopServe();
  const args = serveArgs(spec);
  appendLog('sys', `starting: ${QWEN_BIN} ${args.join(' ')}`);
  serveProc = spawn(QWEN_BIN, args, {
    cwd: spec.workspacePath,
    env: {
      ...process.env,
      ...(spec.serveToken ? { QWEN_SERVER_TOKEN: spec.serveToken } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serveProc.stdout?.on('data', (d: Buffer) => appendLog('info', `[serve] ${d.toString().trim()}`.slice(0, 500)));
  serveProc.stderr?.on('data', (d: Buffer) => appendLog('info', `[serve:err] ${d.toString().trim()}`.slice(0, 500)));
  serveProc.on('exit', (code) => appendLog('sys', `qwen serve exited (${code})`));
}

export async function stopServe(): Promise<void> {
  const proc = serveProc;
  serveProc = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

export function serveAlive(): boolean {
  return serveProc !== null && serveProc.exitCode === null;
}

/** 等待 serve 就绪：web 轮询 8081 端口有 HTTP 响应；bot 进程存活 3s 即视为就绪 */
export async function waitServeReady(mode: 'web' | 'bot', timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (mode === 'bot') {
    await new Promise((r) => setTimeout(r, 3000));
    if (!serveAlive()) throw new Error('qwen serve exited during startup');
    return;
  }
  while (Date.now() < deadline) {
    if (!serveAlive()) throw new Error('qwen serve exited during startup');
    try {
      await fetch('http://127.0.0.1:8081/', { signal: AbortSignal.timeout(2000) });
      return; // 任何 HTTP 响应（含 401）都说明端口已起
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('qwen serve not ready within timeout');
}

/**
 * 任务接力：headless 续跑（`qwen --resume <session> -p <task> --yolo`），
 * 进程退出即任务完成（spec §5.2 F-10 的完成信号）。
 */
export async function runTask(workspacePath: string, sessionId: string, task: string): Promise<number> {
  appendLog('sys', `task relay: qwen --resume ${sessionId} -p <task> --yolo`);
  return await new Promise<number>((resolve) => {
    const proc = spawn(QWEN_BIN, ['--resume', sessionId, '-p', task, '--yolo'], {
      cwd: workspacePath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => appendLog('info', `[task] ${d.toString().trim()}`.slice(0, 500)));
    proc.stderr?.on('data', (d: Buffer) => appendLog('info', `[task:err] ${d.toString().trim()}`.slice(0, 500)));
    proc.on('exit', (code) => resolve(code ?? 1));
    proc.on('error', () => resolve(1));
  });
}
