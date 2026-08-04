/**
 * M1 验收 e2e（spec §7）：不经 Sandbox——
 * push 到 mock Hub/OSS → 手工模拟云端构造返回包 → pull 正确合并代码与 jsonl → 重复 pull 幂等
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIncrementalBundle,
  getWorkspaceScopeDirName,
  packHandoff,
  unpackHandoff,
} from '@agenthub/shared';
import type { HandoffManifest } from '@agenthub/shared';

const HF = 'hf-e2e001';

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

// ---------- mock Hub + OSS ----------
const ossStore = new Map<string, Buffer>();
let hubUrl = '';
let server: Server;
let pushedManifest: HandoffManifest | undefined;
let outputTar: Buffer | undefined;

function startMockHub(): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      const json = (code: number, data: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      // OSS 模拟
      if (url.startsWith('/oss/')) {
        if (req.method === 'PUT') {
          ossStore.set(url, body);
          res.writeHead(200).end();
        } else {
          const data = ossStore.get(url);
          if (!data) res.writeHead(404).end();
          else res.writeHead(200).end(data);
        }
        return;
      }
      // Hub API
      if (req.method === 'POST' && url === '/api/handoffs') {
        json(201, { handoffId: HF, uploadUrl: `${hubUrl}/oss/input`, webUrl: `${hubUrl}/tasks/${HF}` });
      } else if (req.method === 'POST' && url === `/api/handoffs/${HF}/uploaded`) {
        json(200, { status: 'queued' });
      } else if (req.method === 'POST' && url === `/api/handoffs/${HF}/pull-intent`) {
        if (!pushedManifest) return json(409, { error: { code: 'ERR_NOT_READY', message: 'not ready' } });
        json(200, { downloadUrl: `${hubUrl}/oss/output`, manifest: pushedManifest });
      } else if (req.method === 'GET' && url.startsWith('/api/handoffs')) {
        json(200, { items: [] });
      } else {
        json(404, { error: { code: 'ERR_NOT_FOUND', message: url } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      hubUrl = `http://127.0.0.1:${addr.port}`;
      resolve(hubUrl);
    });
  });
}

// ---------- 测试环境 ----------
let repo: string;
let qwenHomeDir: string;
let sessionId = 'sess-e2e-uuid';
const origCwd = process.cwd();

before(async () => {
  await startMockHub();

  // 本地仓库 + 一次提交（realpath 避免 macOS /var symlink 导致 wsHash 不一致）
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'ah-e2e-repo-')));
  sh(repo, 'git', ['init', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 't@x']);
  sh(repo, 'git', ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'main.ts'), 'console.log(1)\n');
  sh(repo, 'git', ['add', '.']);
  sh(repo, 'git', ['commit', '-m', 'init', '--no-verify']);

  // 本地 qwen-home 与 session（20 轮压缩为 2 条示意）
  qwenHomeDir = mkdtempSync(join(tmpdir(), 'ah-e2e-qwen-'));
  const chats = join(qwenHomeDir, 'projects', getWorkspaceScopeDirName(repo), 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(
    join(chats, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: 'user', content: '重构 order-service', timestamp: '2026-08-04T01:00:00Z' }),
      JSON.stringify({ type: 'assistant', content: '开始分析', timestamp: '2026-08-04T01:00:10Z' }),
    ].join('\n') + '\n',
  );

  // CLI 配置（已登录态）
  const cfgDir = mkdtempSync(join(tmpdir(), 'ah-e2e-cfg-'));
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ hubUrl, token: 'test-token' }));

  process.env.QWEN_HOME = qwenHomeDir;
  process.env.AGENTHUB_CONFIG_DIR = cfgDir;
  process.env.AGENTHUB_HUB_URL = hubUrl;
  process.chdir(repo);
});

after(() => {
  process.chdir(origCwd);
  server?.close();
});

describe('M1 端到端（CLI ↔ mock Hub ↔ mock OSS）', () => {
  it('push：输入包上传，marker 写入本地 session', async () => {
    const { runPush } = await import('./push.js');
    await runPush({ task: '继续重构并补单测' });

    // 输入包已上传
    const input = ossStore.get('/oss/input');
    assert.ok(input, '输入包应已上传到 OSS');

    // 本地 session 末尾有 marker
    const chats = join(qwenHomeDir, 'projects', getWorkspaceScopeDirName(repo), 'chats');
    const lines = readFileSync(join(chats, `${sessionId}.jsonl`), 'utf8').trim().split('\n');
    assert.match(lines.at(-1)!, /agenthub_handoff_marker/);

    // 输入包可解包且 manifest 正确
    const work = mkdtempSync(join(tmpdir(), 'ah-e2e-verify-'));
    writeFileSync(join(work, 'input.tar.gz'), input!);
    const pkg = await unpackHandoff(join(work, 'input.tar.gz'), join(work, 'x'));
    assert.equal(pkg.manifest.handoffId, HF);
    assert.equal(pkg.manifest.sessionId, sessionId);
    assert.ok(pkg.bundlePath, '应含 repo.bundle');
    pushedManifest = pkg.manifest;
  });

  it('模拟云端：解输入包 → 干活 commit → 会话增量 → 打返回包', async () => {
    assert.ok(pushedManifest);
    const cloud = mkdtempSync(join(tmpdir(), 'ah-e2e-cloud-'));
    const input = ossStore.get('/oss/input')!;
    writeFileSync(join(cloud, 'input.tar.gz'), input);
    const pkg = await unpackHandoff(join(cloud, 'input.tar.gz'), join(cloud, 'unpacked'));

    // 从 bundle 还原仓库并"干活"
    const cloudRepo = join(cloud, 'repo');
    sh(cloud, 'git', ['clone', pkg.bundlePath!, cloudRepo]);
    sh(cloudRepo, 'git', ['checkout', pushedManifest!.repo.branch]);
    sh(cloudRepo, 'git', ['config', 'user.email', 'cloud@x']);
    sh(cloudRepo, 'git', ['config', 'user.name', 'cloud']);
    writeFileSync(join(cloudRepo, 'refactored.ts'), 'export const ok = true\n');
    sh(cloudRepo, 'git', ['add', '.']);
    sh(cloudRepo, 'git', ['commit', '-m', 'refactor: cloud work', '--no-verify']);
    const bundle = join(cloud, 'result.bundle');
    assert.equal(createIncrementalBundle(cloudRepo, bundle, pushedManifest!.repo.baseCommit), true);

    // 云端会话增量：在移交 jsonl 后追加 2 条
    const wsHash = pushedManifest!.wsHash;
    const cloudChats = join(pkg.qwenHomeDir!, 'projects', wsHash, 'chats');
    const sessFile = join(cloudChats, `${sessionId}.jsonl`);
    const extra =
      [
        JSON.stringify({ type: 'assistant', content: '云端：已完成重构', timestamp: '2026-08-04T05:00:00Z' }),
        JSON.stringify({ type: 'assistant', content: '云端：单测已补', timestamp: '2026-08-04T05:10:00Z' }),
      ].join('\n') + '\n';
    writeFileSync(sessFile, readFileSync(sessFile, 'utf8') + extra);

    // 打返回包并"上传"
    const outManifest: HandoffManifest = {
      ...pushedManifest!,
      direction: 'pull',
      result: {
        status: 'done',
        cloudHead: sh(cloudRepo, 'git', ['rev-parse', 'HEAD']),
        commitCount: 1,
        newSessionIds: [],
        elapsedSeconds: 42,
      },
    };
    const outPath = join(cloud, 'output.tar.gz');
    await packHandoff({ manifest: outManifest, bundlePath: bundle, qwenHomeDir: pkg.qwenHomeDir }, outPath);
    outputTar = readFileSync(outPath);
    ossStore.set('/oss/output', outputTar);
    pushedManifest = outManifest;
  });

  it('pull（无分叉）：fast-forward + jsonl append，qwen 时间线完整', async () => {
    const { runPull } = await import('./pull.js');
    await runPull(HF, {});

    // git：云端 commit 已合入
    assert.match(sh(repo, 'git', ['log', '--oneline']), /cloud work/);
    assert.equal(readFileSync(join(repo, 'refactored.ts'), 'utf8'), 'export const ok = true\n');

    // jsonl：前缀 2 + marker + 云端 2（带 source）+ merged_marker
    const chats = join(qwenHomeDir, 'projects', getWorkspaceScopeDirName(repo), 'chats');
    const lines = readFileSync(join(chats, `${sessionId}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[3], /agenthub_source.*cloud/);
    assert.match(lines.at(-1)!, /agenthub_merged_marker/);
  });

  it('重复 pull：幂等（git 与 jsonl 均不再变化）', async () => {
    const chats = join(qwenHomeDir, 'projects', getWorkspaceScopeDirName(repo), 'chats');
    const jsonlBefore = readFileSync(join(chats, `${sessionId}.jsonl`), 'utf8');
    const headBefore = sh(repo, 'git', ['rev-parse', 'HEAD']);

    const { runPull } = await import('./pull.js');
    await runPull(HF, {});

    assert.equal(readFileSync(join(chats, `${sessionId}.jsonl`), 'utf8'), jsonlBefore);
    assert.equal(sh(repo, 'git', ['rev-parse', 'HEAD']), headBefore);
  });
});
