/**
 * M1 验收 e2e（spec §7 D2-3）：CLI 对 mock Hub 跑 push/pull 全流程——
 * push → 手工模拟云端构造返回包 → pull 三场景（无分叉 / 分叉 / 重复 pull 幂等）
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIncrementalBundle,
  getWorkspaceScopeDirName,
  packHandoff,
  unpackHandoff,
} from '@agenthub/shared';
import type { HandoffManifest } from '@agenthub/shared';

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

// ---------- mock Hub + OSS（多 handoff） ----------
const ossStore = new Map<string, Buffer>();
const manifests = new Map<string, HandoffManifest>();
let nextId = 1;
let hubUrl = '';
let server: Server;
/** S21：服务端 includeUntracked 设置；null 表示缺省 true */
let serverIncludeUntracked: boolean | null = null;

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
      // OSS 模拟：/oss/<id>/input|output
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
      const pullIntent = url.match(/^\/api\/handoffs\/(hf-[0-9a-f]{6})\/pull-intent$/);
      if (req.method === 'GET' && url === '/api/settings') {
        json(200, {
          settings: {
            includeUntracked: serverIncludeUntracked ?? true,
            mergeMode: 'merge',
            backupSessions: false,
            notifyStatusChange: true,
            notifyChatSync: false,
            webhook: { configured: false, masked: null },
          },
        });
        return;
      }
      if (req.method === 'POST' && url === '/api/handoffs') {
        const id = `hf-e2e${String(nextId++).padStart(3, '0')}`;
        json(201, { handoffId: id, uploadUrl: `${hubUrl}/oss/${id}/input`, webUrl: `${hubUrl}/tasks/${id}` });
      } else if (req.method === 'POST' && /\/uploaded$/.test(url)) {
        json(200, { status: 'queued' });
      } else if (req.method === 'POST' && pullIntent) {
        const m = manifests.get(pullIntent[1]);
        if (!m) return json(409, { error: { code: 'ERR_NOT_READY', message: 'not ready' } });
        json(200, { downloadUrl: `${hubUrl}/oss/${pullIntent[1]}/output`, manifest: m });
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
const sessionId = 'sess-e2e-uuid';
const origCwd = process.cwd();

const HF1 = 'hf-e2e001';
const HF2 = 'hf-e2e002';

function sessionFile(): string {
  return join(qwenHomeDir, 'projects', getWorkspaceScopeDirName(repo), 'chats', `${sessionId}.jsonl`);
}

function sessionLines(): string[] {
  return readFileSync(sessionFile(), 'utf8').trim().split('\n');
}

/** 模拟云端：解输入包 → 干活 commit → 会话增量 → 打返回包上传 */
async function simulateCloud(id: string, workFile: string, cloudMsgs: string[]): Promise<void> {
  const cloud = mkdtempSync(join(tmpdir(), `ah-e2e-cloud-${id}-`));
  writeFileSync(join(cloud, 'input.tar.gz'), ossStore.get(`/oss/${id}/input`)!);
  const pkg = await unpackHandoff(join(cloud, 'input.tar.gz'), join(cloud, 'unpacked'));
  const m = pkg.manifest;

  const cloudRepo = join(cloud, 'repo');
  sh(cloud, 'git', ['clone', pkg.bundlePath!, cloudRepo]);
  sh(cloudRepo, 'git', ['checkout', m.repo.branch]);
  sh(cloudRepo, 'git', ['config', 'user.email', 'cloud@x']);
  sh(cloudRepo, 'git', ['config', 'user.name', 'cloud']);
  writeFileSync(join(cloudRepo, workFile), `cloud work for ${id}\n`);
  sh(cloudRepo, 'git', ['add', '.']);
  sh(cloudRepo, 'git', ['commit', '-m', `refactor: cloud work ${id}`, '--no-verify']);
  const bundle = join(cloud, 'result.bundle');
  assert.equal(createIncrementalBundle(cloudRepo, bundle, m.repo.baseCommit), true);

  const sessFile = join(pkg.qwenHomeDir!, 'projects', m.wsHash, 'chats', `${sessionId}.jsonl`);
  appendFileSync(sessFile, cloudMsgs.join('\n') + '\n');

  const outManifest: HandoffManifest = {
    ...m,
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
  ossStore.set(`/oss/${id}/output`, readFileSync(outPath));
  manifests.set(id, outManifest);
}

beforeAll(async () => {
  await startMockHub();

  // 本地仓库 + 一次提交（realpath 避免 macOS /var symlink 导致 wsHash 不一致）
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'ah-e2e-repo-')));
  sh(repo, 'git', ['init', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 't@x']);
  sh(repo, 'git', ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'main.ts'), 'console.log(1)\n');
  sh(repo, 'git', ['add', '.']);
  sh(repo, 'git', ['commit', '-m', 'init', '--no-verify']);

  // 本地 qwen-home 与 session
  qwenHomeDir = mkdtempSync(join(tmpdir(), 'ah-e2e-qwen-'));
  mkdirSync(join(qwenHomeDir, 'projects', getWorkspaceScopeDirName(repo), 'chats'), { recursive: true });
  writeFileSync(
    sessionFile(),
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

afterAll(() => {
  process.chdir(origCwd);
  server?.close();
});

describe('M1 端到端（CLI ↔ mock Hub ↔ mock OSS）', () => {
  it('push：输入包上传，marker 写入本地 session，包结构完整', async () => {
    const { runPush } = await import('./push.js');
    await runPush({ task: '继续重构并补单测' });

    const input = ossStore.get(`/oss/${HF1}/input`);
    assert.ok(input, '输入包应已上传到 OSS');
    assert.match(sessionLines().at(-1)!, /agenthub_handoff_marker/);

    const work = mkdtempSync(join(tmpdir(), 'ah-e2e-verify-'));
    writeFileSync(join(work, 'input.tar.gz'), input!);
    const pkg = await unpackHandoff(join(work, 'input.tar.gz'), join(work, 'x'));
    assert.equal(pkg.manifest.handoffId, HF1);
    assert.equal(pkg.manifest.sessionId, sessionId);
    assert.ok(pkg.bundlePath, '应含 repo.bundle');
  });

  it('pull 场景 1（无分叉）：fast-forward + jsonl append', async () => {
    await simulateCloud(HF1, 'refactored.ts', [
      JSON.stringify({ type: 'assistant', content: '云端：已完成重构', timestamp: '2026-08-04T05:00:00Z' }),
      JSON.stringify({ type: 'assistant', content: '云端：单测已补', timestamp: '2026-08-04T05:10:00Z' }),
    ]);

    const { runPull } = await import('./pull.js');
    await runPull(HF1, {});

    assert.match(sh(repo, 'git', ['log', '--oneline']), /cloud work hf-e2e001/);
    assert.equal(readFileSync(join(repo, 'refactored.ts'), 'utf8'), `cloud work for ${HF1}\n`);

    // 前缀 2 + marker + 云端 2（带 source）+ merged_marker = 6
    const lines = sessionLines();
    assert.equal(lines.length, 6);
    assert.match(lines[3], /agenthub_source.*cloud/);
    assert.match(lines.at(-1)!, /agenthub_merged_marker/);
  });

  it('pull 场景 3（重复 pull）：git 与 jsonl 均幂等', async () => {
    const jsonlBefore = readFileSync(sessionFile(), 'utf8');
    const headBefore = sh(repo, 'git', ['rev-parse', 'HEAD']);

    const { runPull } = await import('./pull.js');
    await runPull(HF1, {});

    assert.equal(readFileSync(sessionFile(), 'utf8'), jsonlBefore);
    assert.equal(sh(repo, 'git', ['rev-parse', 'HEAD']), headBefore);
  });

  it('pull 场景 2（分叉）：本地新 commit + 本地会话增量 → merge + 时间戳交错合并', async () => {
    // 第二次 push
    const { runPush } = await import('./push.js');
    await runPush({ task: '继续优化' });

    // push 后本地继续干活：改代码 commit + 会话新增 1 条（制造分叉）
    writeFileSync(join(repo, 'local-work.ts'), 'local change\n');
    sh(repo, 'git', ['add', '.']);
    sh(repo, 'git', ['commit', '-m', 'local: continue work', '--no-verify']);
    appendFileSync(
      sessionFile(),
      JSON.stringify({ type: 'user', content: '本地：顺便调整命名', timestamp: '2026-08-04T06:05:00Z' }) + '\n',
    );

    // 云端同期干活（不同文件，git 无冲突；会话时间戳穿插本地增量前后）
    await simulateCloud(HF2, 'cloud-work.ts', [
      JSON.stringify({ type: 'assistant', content: '云端：优化完成', timestamp: '2026-08-04T06:00:00Z' }),
      JSON.stringify({ type: 'assistant', content: '云端：收尾', timestamp: '2026-08-04T06:10:00Z' }),
    ]);

    const { runPull } = await import('./pull.js');
    await runPull(HF2, {});

    // git：分叉 → merge commit，双方文件都在
    const log = sh(repo, 'git', ['log', '--oneline', '-5']);
    assert.match(log, /AgentHub: merge cloud commits of hf-e2e002/);
    assert.equal(readFileSync(join(repo, 'cloud-work.ts'), 'utf8'), `cloud work for ${HF2}\n`);
    assert.equal(readFileSync(join(repo, 'local-work.ts'), 'utf8'), 'local change\n');

    // jsonl：分叉交错——merge_notice + 云端 06:00 → 本地 06:05 → 云端 06:10
    const lines = sessionLines();
    const noticeIdx = lines.findIndex((l) => l.includes('agenthub_merge_notice'));
    assert.ok(noticeIdx > 0, '应插入合并系统消息');
    assert.match(lines[noticeIdx + 1], /优化完成/);
    assert.match(lines[noticeIdx + 2], /本地：顺便调整命名/);
    assert.doesNotMatch(lines[noticeIdx + 2], /agenthub_source/);
    assert.match(lines[noticeIdx + 3], /云端：收尾/);
    assert.match(lines.at(-1)!, /agenthub_merged_marker/);
  });

  it('pull 场景 4（S21）：服务端 includeUntracked 真生效——false 时未跟踪文件不进快照', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'local only\n');
    try {
      const { runPush } = await import('./push.js');

      serverIncludeUntracked = true;
      await runPush({ task: 'with untracked' });
      const w1 = mkdtempSync(join(tmpdir(), 'ah-e2e-u1-'));
      writeFileSync(join(w1, 'in.tar.gz'), ossStore.get('/oss/hf-e2e003/input')!);
      const p1 = await unpackHandoff(join(w1, 'in.tar.gz'), join(w1, 'x'));
      assert.ok(p1.worktreeDir && existsSync(join(p1.worktreeDir, 'untracked.txt')), '服务端 true 时未跟踪文件应进快照');

      serverIncludeUntracked = false;
      await runPush({ task: 'without untracked' });
      const w2 = mkdtempSync(join(tmpdir(), 'ah-e2e-u2-'));
      writeFileSync(join(w2, 'in.tar.gz'), ossStore.get('/oss/hf-e2e004/input')!);
      const p2 = await unpackHandoff(join(w2, 'in.tar.gz'), join(w2, 'x'));
      assert.ok(
        !p2.worktreeDir || !existsSync(join(p2.worktreeDir, 'untracked.txt')),
        '服务端 false 时未跟踪文件不应进快照',
      );
    } finally {
      serverIncludeUntracked = null;
      rmSync(join(repo, 'untracked.txt'), { force: true });
    }
  });
});
