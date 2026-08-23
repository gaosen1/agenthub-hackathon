/**
 * 终态会话回放（侧边栏单 UI 架构）：沙箱销毁后本地起一个 qwen serve「replay 实例」+
 * 一层剥 CSP 的透明代理，把 OSS 返回包里的 session jsonl 还原进 replay serve 的
 * projects 目录。iframe 指向 replay 代理，终态也用原生 web shell 展示（可读、可继续追问）。
 *
 * 端口/目录均可 env 覆盖；全部懒启动，无返回包（老任务）时上层回退 HistoryView。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pipeHttp, type PipeOpts } from './ide-proxy.js';

const execFileAsync = promisify(execFile);

const QWEN_BIN = process.env.QWEN_BIN ?? 'qwen';
const REPLAY_PORT = Number(process.env.AGENTHUB_REPLAY_PORT ?? 4182);
const REPLAY_PROXY_PORT = Number(process.env.AGENTHUB_REPLAY_PROXY_PORT ?? 4183);

/** qwen serve daemon 用 SHA256(workspacePath) 前 16 位作 projects 分片目录（与 runner 同算法） */
function wsHash(workspacePath: string): string {
  return createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 16);
}

function baseDir(): string {
  const dbPath = process.env.HUB_DB_PATH ?? './data/hub.sqlite';
  // qwen serve 要求 --workspace 绝对路径（HUB_DB_PATH 常为相对）
  return resolve(join(dirname(dbPath), 'replay'));
}

/** 真 qwen 不读 QWEN_HOME_DIR：replay serve 的会话目录只能是真实 ~/.qwen（分片按 replay workspace 哈希，不与本地会话冲突） */
const replayHome = (): string => join(homedir(), '.qwen');

const PIPE_OPTS: PipeOpts = {
  // serve 对 http 祖先硬设 frame-ancestors 'none'：代理层剥掉才允许 hub 页 iframe 嵌入
  stripResHeaders: new Set(['content-security-policy', 'x-frame-options']),
  // web-shell 从 #token= 读凭证后自带 Bearer，需透传给 replay serve
  keepAuthorization: true,
};

interface ReplayState {
  serve: ChildProcess;
  proxy: Server;
  token: string;
  workspace: string;
  home: string;
}

let state: ReplayState | undefined;
let starting: Promise<ReplayState> | undefined;

async function start(): Promise<ReplayState> {
  const workspace = join(baseDir(), 'workspace');
  const home = replayHome();
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const token = randomBytes(24).toString('hex');

  const serve = spawn(QWEN_BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(REPLAY_PORT), '--workspace', workspace, '--allow-origin', '*'], {
    cwd: workspace,
    env: { ...process.env, QWEN_SERVER_TOKEN: token },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  serve.on('exit', () => {
    state = undefined; // 意外退出后下次请求重建
  });

  // 等端口起（任何 HTTP 响应含 401 都算起）
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (serve.exitCode !== null) throw new Error(`qwen replay serve exited (${serve.exitCode})`);
    try {
      await fetch(`http://127.0.0.1:${REPLAY_PORT}/`, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('qwen replay serve not ready within timeout');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 根路径透明代理（web-shell API 走根绝对路径，不能挂子前缀）：仅剥 CSP 类响应头
  const proxy = createServer((req, res) => {
    req.on('error', () => res.destroy());
    pipeHttp(req, res, `http://127.0.0.1:${REPLAY_PORT}`, req.url ?? '/', '', PIPE_OPTS);
  });
  proxy.on('connection', (socket) => socket.on('error', () => socket.destroy()));
  await new Promise<void>((resolveListen, reject) => {
    proxy.once('error', reject);
    proxy.listen(REPLAY_PROXY_PORT, '127.0.0.1', () => resolveListen());
  });

  state = { serve, proxy, token, workspace, home };
  return state;
}

function ensure(): Promise<ReplayState> {
  if (state) return Promise.resolve(state);
  starting ??= start().finally(() => {
    starting = undefined;
  });
  return starting;
}

/** 还原新 session 后重启 serve：daemon 启动时 lazy-reload routes.json，运行中不扫盘 */
async function restart(): Promise<void> {
  const st = state;
  if (!st) return;
  state = undefined;
  const exited = new Promise<void>((r) => {
    if (st.serve.exitCode !== null) return r();
    st.serve.once('exit', () => r());
    setTimeout(r, 5_000);
  });
  st.serve.kill();
  await exited;
  await new Promise<void>((r) => st.proxy.close(() => r()));
}

/** 从 OSS 返回包还原 session jsonl 到 replay serve 的 projects 分片目录；返回是否新还原（已存在则 false） */
async function restoreSession(st: ReplayState, sessionId: string, signGet: (key: string) => Promise<string>, outputOssKey: string | null): Promise<boolean> {
  const dest = join(st.home, 'projects', wsHash(st.workspace), 'chats', `${sessionId}.jsonl`);
  if (existsSync(dest)) return false;
  if (!outputOssKey) throw new Error('handoff has no output package');
  const url = await signGet(outputOssKey);
  const pkg = join(tmpdir(), `agenthub-replay-${sessionId}.tar.gz`);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`download output package failed: ${res.status}`);
  await fs.writeFile(pkg, Buffer.from(await res.arrayBuffer()));
  const stage = join(tmpdir(), `agenthub-replay-${sessionId}`);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  try {
    await execFileAsync('tar', ['-xzf', pkg, '-C', stage]);
    // 包内布局 qwen-home/projects/<wsHash>/chats/<sid>.jsonl（wsHash 为沙箱侧分片，还原时统一换本地分片）
    const src = join(stage, 'qwen-home', 'projects');
    let found: string | undefined;
    for (const shard of await fs.readdir(src).catch(() => [])) {
      const cand = join(src, shard, 'chats', `${sessionId}.jsonl`);
      if (existsSync(cand)) {
        found = cand;
        break;
      }
    }
    if (!found) throw new Error(`session ${sessionId} not found in output package`);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.copyFile(found, dest);
    return true;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(pkg, { force: true }).catch(() => undefined);
  }
}

/**
 * 终态 handoff 的回放入口 URL；无返回包/还原失败时抛错（上层回退 HistoryView）。
 * 先 restore 后 ensure：无包任务不白起本地 serve。
 */
export async function replayShellUrl(
  h: { session_id: string; output_oss_key: string | null },
  signGet: (key: string) => Promise<string>,
): Promise<string> {
  // 先判断包/文件存在性再起进程：无包任务不白起本地 serve
  const workspace = join(baseDir(), 'workspace');
  const home = replayHome();
  const dest = join(home, 'projects', wsHash(workspace), 'chats', `${h.session_id}.jsonl`);
  if (!existsSync(dest) && !h.output_oss_key) throw new Error('handoff has no output package');
  const st0 = await ensure();
  const restored = await restoreSession(st0, h.session_id, signGet, h.output_oss_key);
  // 新还原的 session 需重启 serve 才能进 routes（daemon 启动时 lazy-reload）
  const st = restored ? ((await restart()), await ensure()) : st0;
  return `http://127.0.0.1:${REPLAY_PROXY_PORT}/session/${encodeURIComponent(h.session_id)}#token=${st.token}`;
}
