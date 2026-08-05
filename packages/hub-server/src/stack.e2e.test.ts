/**
 * 跨栈集成测试（本地版 CP-2 主链路，spec §7）：
 * 真实 hub-server（buildApp + Worker）编排**真实 runner 子进程**（tsx 启动 sandbox 包源码），
 * 中间经真实 HTTP：签名 URL（本地 OSS 替身）→ /load 还原真实 tar 包 → stub qwen task 续跑
 * → healthz taskDone → Worker packaging → /snapshot 上传返回包 → done。
 * 唯一被替身的是 K8s（FakeOrchestrator）与 qwen 本体（stub 脚本）。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getWorkspaceScopeDirName, type HandoffManifest } from '@agenthub/shared';
import { buildApp } from './app.js';
import { openDb, type DB } from './db.js';
import type { OssSigner } from './oss.js';
import type { PodOrchestrator, PodPhase, SandboxPodSpec } from './k8s.js';
import { Worker } from './worker.js';
import { getHandoff } from './store.js';

const RUNNER_PORT = 18234;
const __dir = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = join(__dir, '..', '..', 'sandbox');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString().trim();

class FakeOrchestrator implements PodOrchestrator {
  pods = new Map<string, PodPhase>();
  async createPod(spec: SandboxPodSpec) {
    this.pods.set(spec.podName, 'ready');
  }
  async deletePod(name: string) {
    this.pods.delete(name);
  }
  async getPodPhase(name: string): Promise<PodPhase> {
    return this.pods.get(name) ?? 'gone';
  }
  async listSandboxPodNames() {
    return [...this.pods.keys()];
  }
  async createSecret() {}
  async deleteSecret() {}
}

let root: string;
let ossServer: Server;
let ossBase: string;
let runnerProc: ChildProcess;
let db: DB;
const uploads = new Map<string, Buffer>();
const downloads = new Map<string, Buffer>();

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ah-stack-e2e-'));

  // stub qwen：serve 起 8081；--resume -p 提交一个空 commit 后退出（云端产出）
  const stub = join(root, 'qwen-stub.mjs');
  await fs.writeFile(
    stub,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'serve') {
  const http = await import('node:http');
  http.createServer((_q, s) => s.end('ok')).listen(8081);
} else if (args.includes('--resume')) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['-c','user.name=cloud','-c','user.email=c@c','commit','--allow-empty','-m','cloud-work'], { cwd: process.cwd() });
  process.exit(0);
} else { process.exit(1); }
`,
  );
  await fs.chmod(stub, 0o755);

  // 本地 OSS 替身
  ossServer = createServer((req, res) => {
    if (req.method === 'GET') {
      const data = downloads.get(req.url ?? '');
      if (!data) return void res.writeHead(404).end();
      return void res.writeHead(200).end(data);
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        uploads.set(req.url ?? '', Buffer.concat(chunks));
        res.writeHead(200).end('{}');
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((r) => ossServer.listen(0, '127.0.0.1', r));
  ossBase = `http://127.0.0.1:${(ossServer.address() as { port: number }).port}`;

  // 真实 runner 子进程（tsx 跑 sandbox 源码）。不设 RUNNER_TOKEN：
  // Worker 每次为 Pod 生成随机 token 并经 env 注入，本测试中 runner 先于 handoff 启动无法拿到，
  // 故走“未配置 token 则跳过鉴权”分支（token 不匹配返回 401 的行为由单测与真实 Pod 链路覆盖）
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RUNNER_PORT: String(RUNNER_PORT),
    RUNNER_MODE: 'web',
    QWEN_BIN: stub,
    QWEN_HOME_DIR: join(root, 'qwen-home-live'),
    RUNNER_WORK_DIR: join(root, 'runner-work'),
  };
  runnerProc = spawn('node', ['--import', 'tsx', 'src/runner.ts'], { cwd: SANDBOX_DIR, env, stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${RUNNER_PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      // 未就绪
    }
    if (Date.now() > deadline) throw new Error('runner subprocess not ready');
    await new Promise((r) => setTimeout(r, 300));
  }

  db = openDb(':memory:');
}, 60_000);

afterAll(async () => {
  runnerProc?.kill('SIGTERM');
  ossServer?.close();
  db?.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function buildInputPackage(): Promise<HandoffManifest> {
  const workspacePath = join(root, 'proj');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(join(workspacePath, 'a.txt'), 'hello');
  git(workspacePath, 'init', '-b', 'main');
  git(workspacePath, 'add', '.');
  git(workspacePath, 'commit', '-m', 'base');
  const baseCommit = git(workspacePath, 'rev-parse', 'HEAD');
  const wsHash = getWorkspaceScopeDirName(workspacePath);
  const manifest: HandoffManifest = {
    version: 1,
    handoffId: 'hf-17e5f1',
    direction: 'push',
    agentName: 'proj',
    workspacePath,
    wsHash,
    repo: { baseCommit, branch: 'main', dirty: false },
    sessionId: 'sess-itest',
    task: '继续干活',
    timeoutMinutes: 30,
    qwenVersion: 'stub',
    createdAt: new Date().toISOString(),
  };
  const pkg = join(root, 'input-pkg');
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(join(pkg, 'manifest.json'), JSON.stringify(manifest));
  git(workspacePath, 'bundle', 'create', join(pkg, 'repo.bundle'), '--all');
  const chats = join(pkg, 'qwen-home', 'projects', wsHash, 'chats');
  await fs.mkdir(chats, { recursive: true });
  await fs.writeFile(join(chats, 'sess-itest.jsonl'), '{"role":"user","content":"hi"}\n');
  const tarball = join(root, 'input.tar.gz');
  await tar.c({ file: tarball, cwd: pkg, gzip: true }, await fs.readdir(pkg));
  downloads.set('/input.tar.gz', await fs.readFile(tarball));
  await fs.rm(workspacePath, { recursive: true, force: true });
  return manifest;
}

describe('hub-server × 真实 runner 全链路（本地版 CP-2）', () => {
  it('push → queued → Worker 编排 → task 续跑 → packaging → done，返回包落 OSS 替身', async () => {
    const manifest = await buildInputPackage();

    const signer: OssSigner = {
      signPut: async () => `${ossBase}/output.tar.gz`,
      signGet: async () => `${ossBase}/input.tar.gz`,
    };
    const orch = new FakeOrchestrator();
    const connector = {
      getBaseUrl: async () => `http://127.0.0.1:${RUNNER_PORT}`,
      dispose: async () => undefined,
    };
    const worker = new Worker(db, orch, connector, signer, { namespace: 'agenthub', image: 'test/sandbox:itest' });
    const app = buildApp({ db, signer, secret: 'itest', sandbox: { connector, orchestrator: orch, namespace: 'agenthub', image: 'test/sandbox:itest', worker } });

    // 创建 handoff 并上传回执
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret123' } });
    const token = (reg.json() as { token: string }).token;
    const created = await app.inject({
      method: 'POST',
      url: '/api/handoffs',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        agentName: manifest.agentName,
        workspacePath: manifest.workspacePath,
        wsHash: manifest.wsHash,
        sessionId: manifest.sessionId,
        baseCommit: manifest.repo.baseCommit,
        branch: 'main',
        task: manifest.task,
        kind: 'web',
        timeoutMinutes: 30,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { handoffId: string }).handoffId;
    await app.inject({ method: 'POST', url: `/api/handoffs/${id}/uploaded`, headers: { authorization: `Bearer ${token}` } });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await worker.tick();
      const h = getHandoff(db, id)!;
      if (h.status === 'done' || h.status === 'failed' || h.status === 'expired') break;
      await new Promise((r) => setTimeout(r, 400));
    }

    const final = getHandoff(db, id)!;
    expect(final.error).toBeNull();
    expect(final.status).toBe('done');
    expect(final.result_manifest).toContain('"commitCount":1');

    // 返回包已上传到 OSS 替身，结构可解
    const uploaded = uploads.get('/output.tar.gz');
    expect(uploaded).toBeDefined();
    const outDir = join(root, 'stack-out');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(join(root, 'stack-out.tar.gz'), uploaded!);
    await tar.x({ file: join(root, 'stack-out.tar.gz'), cwd: outDir });
    const outManifest = JSON.parse(await fs.readFile(join(outDir, 'manifest.json'), 'utf8')) as HandoffManifest;
    expect(outManifest.result?.status).toBe('done');

    // detail：终态含 result 与 downloadUrl；日志已搬运
    const detail = await app.inject({ method: 'GET', url: `/api/handoffs/${id}`, headers: { authorization: `Bearer ${token}` } });
    const body = detail.json() as { status: string; result?: { commitCount: number }; downloadUrl?: string };
    expect(body.status).toBe('done');
    expect(body.result?.commitCount).toBe(1);
    expect(body.downloadUrl).toContain('/input.tar.gz'); // fake signer 固定返回
    const events = await app.inject({ method: 'GET', url: `/api/handoffs/${id}/events`, headers: { authorization: `Bearer ${token}` } });
    const payloads = (events.json() as { items: Array<{ kind: string; payload: string }> }).items;
    expect(payloads.some((e) => e.kind === 'log' && e.payload.includes('task relay finished'))).toBe(true);

    await app.close();
  }, 90_000);
});
