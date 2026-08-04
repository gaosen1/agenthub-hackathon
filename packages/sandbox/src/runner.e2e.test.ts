/**
 * runner 集成测试（spec §7 D2–D3 验收项）：
 * 构造真实输入包（manifest + repo.bundle + worktree + qwen-home）→ /load 还原（含 wsHash 校验、
 * 绝对路径重建、stub qwen 的 task headless 续跑与 serve 拉起）→ /snapshot 产出返回包
 * （result.bundle 增量 + chats + logs + result manifest）。
 * qwen 用 stub 脚本替身：serve 起 8081 HTTP；--resume -p 在工作区提交一个 commit 模拟云端产出。
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getWorkspaceScopeDirName, type HandoffManifest } from '@agenthub/shared';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString().trim();

let root: string;
let httpServer: Server;
let httpBase: string;
/** PUT 上传的返回包字节流按 URL 路径存这里 */
const uploads = new Map<string, Buffer>();
/** GET 下载内容按路径提供 */
const downloads = new Map<string, Buffer>();

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ah-runner-e2e-'));

  // stub qwen 可执行脚本
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
} else {
  process.exit(1);
}
`,
  );
  await fs.chmod(stub, 0o755);

  // 本地 HTTP：GET 提供输入包，PUT 收返回包（模拟 OSS 签名 URL 两个方向）
  httpServer = createServer((req, res) => {
    if (req.method === 'GET') {
      const data = downloads.get(req.url ?? '');
      if (!data) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(data);
      return;
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
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const addr = httpServer.address() as { port: number };
  httpBase = `http://127.0.0.1:${addr.port}`;

  // runner 环境（必须在 import runner 前设好）
  process.env.QWEN_BIN = stub;
  process.env.QWEN_HOME_DIR = join(root, 'qwen-home-live');
  process.env.RUNNER_WORK_DIR = join(root, 'runner-work');
  delete process.env.RUNNER_TOKEN;
});

afterAll(async () => {
  const { stopServe } = await import('./qwen.js');
  await stopServe();
  httpServer.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function buildInputPackage(): Promise<{ manifest: HandoffManifest; tarball: Buffer }> {
  // 1. 造一个真实 git 仓库（= 本地项目）
  const workspacePath = join(root, 'proj');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(join(workspacePath, 'a.txt'), 'hello');
  git(workspacePath, 'init', '-b', 'main');
  git(workspacePath, 'add', '.');
  git(workspacePath, 'commit', '-m', 'base');
  const baseCommit = git(workspacePath, 'rev-parse', 'HEAD');

  const wsHash = getWorkspaceScopeDirName(workspacePath);
  const sessionId = 'sess-e2e-1';
  const manifest: HandoffManifest = {
    version: 1,
    handoffId: 'hf-e2e001',
    direction: 'push',
    agentName: 'proj',
    workspacePath,
    wsHash,
    repo: { baseCommit, branch: 'main', dirty: true },
    sessionId,
    task: '继续干活',
    timeoutMinutes: 30,
    qwenVersion: 'stub',
    createdAt: new Date().toISOString(),
  };

  // 2. 组装输入包目录
  const pkg = join(root, 'input-pkg');
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(join(pkg, 'manifest.json'), JSON.stringify(manifest));
  git(workspacePath, 'bundle', 'create', join(pkg, 'repo.bundle'), '--all');
  await fs.mkdir(join(pkg, 'worktree'), { recursive: true });
  await fs.writeFile(join(pkg, 'worktree', 'dirty.txt'), 'uncommitted');
  const chats = join(pkg, 'qwen-home', 'projects', wsHash, 'chats');
  await fs.mkdir(chats, { recursive: true });
  await fs.writeFile(join(chats, `${sessionId}.jsonl`), '{"role":"user","content":"hi"}\n');

  // 3. 打成 tar.gz（先删掉原仓库，验证 runner 是"重建"而非复用）
  const tarball = join(root, 'input.tar.gz');
  await tar.c({ file: tarball, cwd: pkg, gzip: true }, await fs.readdir(pkg));
  await fs.rm(workspacePath, { recursive: true, force: true });
  return { manifest, tarball: await fs.readFile(tarball) };
}

describe('runner /load → /snapshot 端到端（stub qwen）', () => {
  it('还原工作区与会话、task 续跑产出 commit、返回包结构完整', async () => {
    const { manifest, tarball } = await buildInputPackage();
    downloads.set('/input.tar.gz', tarball);

    const { buildRunner } = await import('./runner.js');
    const app = buildRunner();

    // /load（202 异步）
    const load = await app.inject({
      method: 'POST',
      url: '/load',
      payload: { inputUrl: `${httpBase}/input.tar.gz`, task: manifest.task, serveToken: 'tkn' },
    });
    expect(load.statusCode).toBe(202);

    // 轮询 healthz 到 serveReady（stub serve 起 8081）
    const deadline = Date.now() + 30_000;
    let health: { serveReady: boolean; taskDone: boolean; lastError?: string } = { serveReady: false, taskDone: false };
    while (Date.now() < deadline) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      health = res.json() as typeof health;
      if (health.serveReady || health.lastError) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(health.lastError).toBeUndefined();
    expect(health.serveReady).toBe(true);
    expect(health.taskDone).toBe(true); // stub --resume 已退出 = 任务完成信号

    // 工作区按原绝对路径重建 + worktree 覆盖 + 云端 commit
    expect((await fs.readFile(join(manifest.workspacePath, 'a.txt'), 'utf8')).toString()).toBe('hello');
    expect((await fs.readFile(join(manifest.workspacePath, 'dirty.txt'), 'utf8')).toString()).toBe('uncommitted');
    const head = git(manifest.workspacePath, 'log', '--oneline');
    expect(head).toContain('cloud-work');
    // 会话历史铺到 ~/.qwen 对应分片目录
    const liveChat = join(process.env.QWEN_HOME_DIR!, 'projects', manifest.wsHash, 'chats', `${manifest.sessionId}.jsonl`);
    expect((await fs.readFile(liveChat, 'utf8')).toString()).toContain('hi');

    // /snapshot：打包上传返回包
    const snap = await app.inject({ method: 'POST', url: '/snapshot', payload: { outputUrl: `${httpBase}/output.tar.gz` } });
    expect(snap.statusCode).toBe(200);
    const uploaded = uploads.get('/output.tar.gz');
    expect(uploaded).toBeDefined();

    // 解包校验返回包结构（spec §3.1 output）
    const outDir = join(root, 'out-unpacked');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(join(root, 'out.tar.gz'), uploaded!);
    await tar.x({ file: join(root, 'out.tar.gz'), cwd: outDir });

    const outManifest = JSON.parse(await fs.readFile(join(outDir, 'manifest.json'), 'utf8')) as HandoffManifest;
    expect(outManifest.direction).toBe('pull');
    expect(outManifest.result?.status).toBe('done');
    expect(outManifest.result?.commitCount).toBe(1); // stub 的 cloud-work commit
    expect(outManifest.result?.cloudHead).toBeTruthy();

    await fs.access(join(outDir, 'result.bundle')); // commit 增量 bundle 存在
    const outChat = join(outDir, 'qwen-home', 'projects', manifest.wsHash, 'chats', `${manifest.sessionId}.jsonl`);
    await fs.access(outChat);
    const events = await fs.readFile(join(outDir, 'logs', 'events.jsonl'), 'utf8');
    expect(events).toContain('task relay finished');

    // result.bundle 可被本地 git 消费（pull 侧闭环的前半段）：verify 退出码 0 即有效
    expect(() => git(manifest.workspacePath, 'bundle', 'verify', join(outDir, 'result.bundle'))).not.toThrow();

    await app.close();
  }, 60_000);
});
