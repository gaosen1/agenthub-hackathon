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
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const dbg = (s) => { try { if (process.env.QWEN_STUB_LOG) fs.appendFileSync(process.env.QWEN_STUB_LOG, s + '\\n'); } catch (e) {} };
  dbg('boot ' + args.join(' '));
  let sseRes = null;
  const send = (u) => { if (sseRes) sseRes.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: u } }) + '\\n\\n'); };
  http.createServer((q, s) => {
    dbg(q.method + ' ' + q.url);
    if (q.url === '/acp' && q.method === 'GET') {
      if (process.env.QWEN_STUB_NO_ACP) { s.writeHead(404).end(); return; }
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      sseRes = s;
      return;
    }
    if (q.url === '/acp' && q.method === 'POST') {
      let b = '';
      q.on('data', (c) => (b += c));
      q.on('end', () => {
        if (process.env.QWEN_STUB_NO_ACP) { s.writeHead(404).end(); return; }
        const m = JSON.parse(b);
        dbg('parsed ' + m.method);
        const reply = (result) => { dbg('reply ' + m.method); s.writeHead(200, { 'content-type': 'application/json', 'acp-connection-id': 'stub-conn' }); s.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
        if (m.method === 'initialize') reply({ protocolVersion: 1 });
        else if (m.method === 'session/load') reply({ modes: { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'yolo' }] } });
        else if (m.method === 'session/set_mode') reply({});
        else if (m.method === 'session/prompt') {
          try { execFileSync('git', ['-c','user.name=cloud','-c','user.email=c@c','commit','--allow-empty','-m','cloud-work'], { cwd: process.cwd() }); } catch (e) {}
          // 真 serve 协议：prompt 先 202，流式帧与最终应答帧都走 SSE
          s.writeHead(202); s.end();
          setTimeout(() => {
            send({ sessionUpdate: 'agent_message_chunk', content: { text: 'cloud line one\\n' } });
            send({ sessionUpdate: 'agent_message_chunk', content: { text: 'cloud line two\\n' } });
            if (sseRes) sseRes.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }) + '\\n\\n');
          }, 60);
        } else reply({});
      });
      return;
    }
    s.end('ok');
  }).listen(8081);
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
  // S19：带 node_modules 与 lockfile，验证依赖缓存快照/还原闭环
  await fs.mkdir(join(pkg, 'worktree', 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(join(pkg, 'worktree', 'node_modules', '.bin', 'jest'), 'stub-bin');
  await fs.writeFile(join(pkg, 'worktree', 'package.json'), '{"name":"proj","version":"1.0.0"}\n');
  await fs.writeFile(join(pkg, 'worktree', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
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
      // serve 先起、任务后经 ACP 跑：须等 taskDone（serveReady 不再意味任务完成）
      if ((health.serveReady && health.taskDone) || health.lastError) break;
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

    // /snapshot：打包上传返回包 + S19 依赖缓存快照/sidecar
    const snap = await app.inject({
      method: 'POST',
      url: '/snapshot',
      payload: {
        outputUrl: `${httpBase}/output.tar.gz`,
        depsCachePutUrl: `${httpBase}/deps.tar.gz`,
        depsSidecarPutUrl: `${httpBase}/deps.json`,
        warmBundlePutUrl: `${httpBase}/warm.bundle`,
        warmSidecarPutUrl: `${httpBase}/warm.json`,
      },
    });
    expect(snap.statusCode).toBe(200);
    const uploaded = uploads.get('/output.tar.gz');
    expect(uploaded).toBeDefined();

    // S19：node_modules 快照与 sidecar 已上传，sidecar 带 lockHash
    const depsTar = uploads.get('/deps.tar.gz');
    expect(depsTar).toBeDefined();
    const sidecar = JSON.parse(uploads.get('/deps.json')!.toString('utf8')) as { lockHash: string; bytes: number };
    expect(sidecar.lockHash.length).toBeGreaterThan(0);
    expect(sidecar.bytes).toBeGreaterThan(0);
    // S20：warm 全量 bundle 与 sidecar 已上传
    expect(uploads.get('/warm.bundle')).toBeDefined();
    const warmMeta = JSON.parse(uploads.get('/warm.json')!.toString('utf8')) as { head: string };
    expect(warmMeta.head.length).toBeGreaterThan(0);

    // 解包校验返回包结构（spec §3.1 output）
    const outDir = join(root, 'out-unpacked');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(join(root, 'out.tar.gz'), uploaded!);
    await tar.x({ file: join(root, 'out.tar.gz'), cwd: outDir });

    const outManifest = JSON.parse(await fs.readFile(join(outDir, 'manifest.json'), 'utf8')) as HandoffManifest;
    expect(outManifest.direction).toBe('pull');
    expect(outManifest.result?.status).toBe('done');
    // stub 的 cloud-work commit + snapshot 前兜底 auto-commit（dirty.txt 未提交变更不丢失）
    expect(outManifest.result?.commitCount).toBe(2);
    expect(git(manifest.workspacePath, 'log', '--oneline')).toContain('auto-commit cloud changes');
    expect(outManifest.result?.cloudHead).toBeTruthy();

    await fs.access(join(outDir, 'result.bundle')); // commit 增量 bundle 存在
    const outChat = join(outDir, 'qwen-home', 'projects', manifest.wsHash, 'chats', `${manifest.sessionId}.jsonl`);
    await fs.access(outChat);
    const events = await fs.readFile(join(outDir, 'logs', 'events.jsonl'), 'utf8');
    expect(events).toContain('task relay finished');
    // serve 路径回归：任务经 ACP 流式执行，relay 日志含流式行（盲点修复）
    expect(events).toContain('task relay via serve');
    expect(events).toContain('cloud line one');

    // result.bundle 可被本地 git 消费（pull 侧闭环的前半段）：verify 退出码 0  即有效
    expect(() => git(manifest.workspacePath, 'bundle', 'verify', join(outDir, 'result.bundle'))).not.toThrow();
    
    // S19 闭环：删掉 node_modules 后二次 /load 带缓存 URL，免重装还原
    await fs.rm(join(manifest.workspacePath, 'node_modules'), { recursive: true, force: true });
    downloads.set('/deps.tar.gz', depsTar!);
    const load2 = await app.inject({
      method: 'POST',
      url: '/load',
      payload: { inputUrl: `${httpBase}/input.tar.gz`, task: manifest.task, depsCacheUrl: `${httpBase}/deps.tar.gz` },
    });
    expect(load2.statusCode).toBe(202);
    const deadline2 = Date.now() + 30_000;
    let health2: { serveReady: boolean; taskDone: boolean; lastError?: string } = { serveReady: false, taskDone: false };
    while (Date.now() < deadline2) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      health2 = res.json() as typeof health2;
      // 同主用例：serve 先起，须等 taskDone 再放行，避免任务 stub 与下一用例并发 commit
      if ((health2.serveReady && health2.taskDone) || health2.lastError) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(health2.lastError).toBeUndefined();
    expect((await fs.readFile(join(manifest.workspacePath, 'node_modules', '.bin', 'jest'), 'utf8')).toString()).toBe('stub-bin');
    
    await app.close();
  }, 60_000);

  it('S20 delta：warm 全量 bundle + 增量 bundle 合成还原', async () => {
    // 上一个 case 留下的 workspace = 上次会话的云端状态；以其 root commit 为 delta 基
    const ws = join(root, 'proj');
    const prevBase = git(ws, 'rev-list', '--max-parents=0', 'HEAD');
    const warmPath = join(root, 'warm-e2e.bundle');
    git(ws, 'bundle', 'create', warmPath, '--all');
    downloads.set('/warm.bundle', await fs.readFile(warmPath));

    // 模拟本地新 commit（push 侧的 HEAD 前进）
    await fs.writeFile(join(ws, 'local-new.txt'), 'local delta');
    git(ws, 'add', '.');
    git(ws, 'commit', '-m', 'local new');
    const localHead = git(ws, 'rev-parse', 'HEAD');
    const deltaPath = join(root, 'delta.bundle');
    git(ws, 'bundle', 'create', deltaPath, `${prevBase}..HEAD`);

    // 第二个输入包：repo.bundle 为增量 + manifest 带 deltaBase
    const pkg2 = join(root, 'input-pkg2');
    await fs.mkdir(pkg2, { recursive: true });
    const manifest2: HandoffManifest = {
      version: 1,
      handoffId: 'hf-e2e002',
      direction: 'push',
      agentName: 'proj',
      workspacePath: ws,
      wsHash: getWorkspaceScopeDirName(ws),
      repo: { baseCommit: localHead, branch: 'main', dirty: false, deltaBase: prevBase },
      sessionId: 'sess-e2e-2',
      timeoutMinutes: 30,
      qwenVersion: 'stub',
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(join(pkg2, 'manifest.json'), JSON.stringify(manifest2));
    await fs.copyFile(deltaPath, join(pkg2, 'repo.bundle'));
    const tarball2 = join(root, 'input2.tar.gz');
    await tar.c({ file: tarball2, cwd: pkg2, gzip: true }, await fs.readdir(pkg2));
    downloads.set('/input2.tar.gz', await fs.readFile(tarball2));

    const { buildRunner } = await import('./runner.js');
    const app = buildRunner();
    const load = await app.inject({
      method: 'POST',
      url: '/load',
      payload: { inputUrl: `${httpBase}/input2.tar.gz`, warmBundleUrl: `${httpBase}/warm.bundle` },
    });
    expect(load.statusCode).toBe(202);
    const deadline = Date.now() + 30_000;
    let health: { serveReady: boolean; lastError?: string } = { serveReady: false };
    while (Date.now() < deadline) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      health = res.json() as typeof health;
      if (health.serveReady || health.lastError) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(health.lastError).toBeUndefined();
    // 合成结果：warm 的历史（cloud-work）+ 本地增量（local new），HEAD 落在本地 head
    expect((await fs.readFile(join(ws, 'local-new.txt'), 'utf8')).toString()).toBe('local delta');
    const log = git(ws, 'log', '--oneline');
    expect(log).toContain('cloud-work');
    expect(log).toContain('local new');
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(localHead);
    await app.close();
  }, 60_000);
});

describe('task relay 回退（serve ACP 不可用）', () => {
  it('runTaskViaServe 拒绝 + headless runTask 接管产出 commit', async () => {
    process.env.QWEN_STUB_NO_ACP = '1';
    try {
      const { startServe, stopServe, waitServeReady, runTaskViaServe, runTask } = await import('./qwen.js');
      const ws = join(root, 'proj-fallback');
      await fs.mkdir(ws, { recursive: true });
      git(ws, 'init', '-b', 'main');
      git(ws, 'commit', '--allow-empty', '-m', 'base');
      await startServe({ mode: 'web', workspacePath: ws, serveToken: 't' });
      await waitServeReady('web');
      await expect(runTaskViaServe(ws, 'sess-fb', 'do it')).rejects.toThrow();
      const code = await runTask(ws, 'sess-fb', 'do it');
      expect(code).toBe(0);
      expect(git(ws, 'log', '--oneline')).toContain('cloud-work');
      await stopServe();
    } finally {
      delete process.env.QWEN_STUB_NO_ACP;
    }
  }, 60_000);
});
