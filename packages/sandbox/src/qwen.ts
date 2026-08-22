/**
 * qwen 进程管理：serve 子进程（可停/重启）+ 任务 headless 续跑
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendLog } from './state.js';

const QWEN_BIN = process.env.QWEN_BIN ?? 'qwen';
/** serve 端口可 env 覆盖（默认 8081）：包内并行测试文件各自隔离，避免 EADDRINUSE */
const servePort = (): string => process.env.AGENTHUB_SERVE_PORT ?? '8081';

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
  // --allow-origin 同时充作 web-shell 的 frame-ancestors：允许 hub 源 iframe 嵌入原生 Shell
  return [
    'serve',
    '--hostname',
    '0.0.0.0',
    '--port',
    servePort(),
    '--workspace',
    spec.workspacePath,
    '--allow-origin',
    process.env.AGENTHUB_WEB_ORIGIN ?? 'http://localhost:4180',
  ];
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
  // qwen 常规日志走 stderr 是 Node CLI 惯例，不代表错误；两流统一前缀，级别由 kind 表达
  serveProc.stdout?.on('data', (d: Buffer) => appendLog('info', `[serve] ${d.toString().trim()}`.slice(0, 500)));
  serveProc.stderr?.on('data', (d: Buffer) => appendLog('info', `[serve] ${d.toString().trim()}`.slice(0, 500)));
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
      await fetch(`http://127.0.0.1:${servePort()}/`, { signal: AbortSignal.timeout(2000) });
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
    // 按行缓冲 stdout/stderr：chunk 边界任意，直接切片会把回答拦腰截断（web 卡片不完整事故）；
    // 单行上限 20000 仅是防病理单行（几 MB 单行 JSON/base64）撑爆日志库的防御阀，正常回复无感；退出时 flush 残余
    const mkLineLogger = (prefix: string) => {
      let buf = '';
      const push = (line: string) => {
        const t = line.trim();
        if (t) appendLog('info', `${prefix} ${t}`.slice(0, 20000));
      };
      return {
        data: (d: Buffer) => {
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            push(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        },
        flush: () => {
          push(buf);
          buf = '';
        },
      };
    };
    const outLog = mkLineLogger('[task]');
    const errLog = mkLineLogger('[task]');
    proc.stdout?.on('data', outLog.data);
    proc.stderr?.on('data', errLog.data);
    proc.on('exit', (code) => {
      outLog.flush();
      errLog.flush();
      resolve(code ?? 1);
    });
    proc.on('error', () => resolve(1));
  });
}

/**
 * 任务接力（serve 路径）：经本地 serve 的 ACP 跑 session/prompt，
 * 让 ACP 订阅者（web 侧栏 / web-shell）实时流式看到任务输出——
 * headless 独立进程对它们是不可见盲点（「执行中侧栏静默」事故）。
 * 输出按行缓冲 relay 进日志（[task] 前缀，与 headless 路径同契约）；
 * 任务期间切 yolo、结束恢复原模式；任何连接失败由调用方回退 runTask。
 */
export async function runTaskViaServe(
  workspacePath: string,
  sessionId: string,
  task: string,
  serveToken?: string,
): Promise<number> {
  const base = `http://127.0.0.1:${servePort()}`;
  const auth: Record<string, string> = serveToken ? { authorization: `Bearer ${serveToken}` } : {};
  const headers: Record<string, string> = { 'content-type': 'application/json', ...auth };
  let rpcId = 0;
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const resolved = new Map<number, Record<string, unknown>>();
  const settle = (m: Record<string, unknown>): void => {
    const cb = pending.get(m.id as number);
    if (cb) {
      pending.delete(m.id as number);
      cb(m);
    } else {
      resolved.set(m.id as number, m);
    }
  };
  const post = async (method: string, params: unknown): Promise<number> => {
    const id = ++rpcId;
    const r = await fetch(`${base}/acp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const cid = r.headers.get('acp-connection-id');
    if (cid) headers['acp-connection-id'] = cid;
    if (r.status >= 400) throw new Error(`ACP ${method} → ${r.status}`);
    try {
      const m = JSON.parse(await r.text()) as Record<string, unknown>;
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) settle(m);
    } catch {
      // 应答帧走 SSE
    }
    return id;
  };
  const wait = (id: number, ms: number): Promise<Record<string, unknown>> => {
    // 同步应答在 post() 内已 settle：先查已决队列，避免「先 settle 后 wait」死等（serve 对 initialize 等是同步应答）
    const hit = resolved.get(id);
    if (hit) {
      resolved.delete(id);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP 应答超时（#${id}）`));
      }, ms);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  };

  // 行缓冲 relay：与 headless 路径同粒度，避免 token 级 chunk 撑爆事件表/破坏历史合卡
  let buf = '';
  const emit = (line: string): void => {
    const t = line.trim();
    if (t) appendLog('info', `[task] ${t}`.slice(0, 20000));
  };
  const feed = (text: string): void => {
    buf += text;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      emit(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  };

  const initId = await post('initialize', { protocolVersion: 1 });
  await wait(initId, 15_000);
  const ac = new AbortController();
  // load 后的 replay 是历史回放，不能进 relay 日志（否则整段旧会话灌进执行日志/卡片）；prompt 发出后才开闸
  const gate = { live: false };
  // 与 acpClient 同构：连接级 SSE（应答帧）+ load 后的 session 级 SSE（session/update 流）
  const openSse = (extra: Record<string, string> = {}): Promise<void> =>
    (async () => {
      const r = await fetch(`${base}/acp`, {
        headers: { accept: 'text/event-stream', ...auth, ...(headers['acp-connection-id'] ? { 'acp-connection-id': headers['acp-connection-id'] } : {}), ...extra },
        signal: ac.signal,
      });
      if (!r.ok || !r.body) return;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let sbuf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sbuf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = sbuf.indexOf('\n\n')) >= 0) {
          const frame = sbuf.slice(0, idx);
          sbuf = sbuf.slice(idx + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data) continue;
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
            settle(m);
            continue;
          }
          if (m.method !== 'session/update') continue;
          if (!gate.live) continue;
          const u = ((m as { params?: { update?: Record<string, unknown> } }).params?.update) ?? {};
          const text = ((u.content as { text?: string } | undefined)?.text ?? (u.text as string | undefined)) ?? '';
          if (u.sessionUpdate === 'agent_message_chunk' && text) feed(text);
          else if (u.sessionUpdate === 'tool_call') emit(`tool: ${(u.title as string | undefined) ?? 'call'}`);
        }
      }
    })().catch(() => undefined);
  const sseConns: Array<Promise<void>> = [openSse()];

  try {
    const loadId = await post('session/load', { sessionId, cwd: workspacePath });
    const loadResp = await wait(loadId, 60_000);
    if (loadResp.error) throw new Error('session/load 失败');
    // session 级 SSE：任务流式事件的真正通道（连接级 SSE 不收 session/update）
    sseConns.push(openSse({ 'acp-session-id': sessionId }));
    const prevMode = (((loadResp.result as { modes?: { currentModeId?: string } } | undefined)?.modes?.currentModeId) ?? 'auto') as string;
    // 无人值守任务切 yolo；失败不致命（serve 可能已是 yolo）
    await post('session/set_mode', { sessionId, modeId: 'yolo' })
      .then((id) => wait(id, 10_000))
      .catch(() => undefined);
    appendLog('sys', `task relay via serve: session/prompt (${sessionId.slice(0, 8)})`);
    const promptId = await post('session/prompt', { sessionId, prompt: [{ type: 'text', text: task }] });
    gate.live = true;
    const resp = await wait(promptId, 30 * 60_000);
    if (resp.error) throw new Error('session/prompt 失败');
    const stop = ((resp.result as { stopReason?: string } | undefined)?.stopReason) ?? 'end_turn';
    // 恢复交互模式，避免任务 yolo 影响后续人工对话
    await post('session/set_mode', { sessionId, modeId: prevMode })
      .then((id) => wait(id, 5_000))
      .catch(() => undefined);
    return stop === 'end_turn' ? 0 : 1;
  } finally {
    ac.abort();
    if (buf) emit(buf);
    void sseConns;
  }
}
