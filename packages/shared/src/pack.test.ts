import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packHandoff, unpackHandoff } from './pack.js';
import { applyResultBundle, createFullBundle, createIncrementalBundle, getRepoInfo } from './git.js';
import { getWorkspaceScopeDirName, newHandoffId, ossKey } from './workspace.js';
import type { HandoffManifest } from './manifest.js';

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

/** 建一个带一次 commit 的临时 git 仓库 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-repo-'));
  sh(dir, 'git', ['init', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'test@agenthub.local']);
  sh(dir, 'git', ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'a.txt'), 'v1\n');
  sh(dir, 'git', ['add', '.']);
  sh(dir, 'git', ['commit', '-m', 'init', '--no-verify']);
  return dir;
}

function makeManifest(overrides: Partial<HandoffManifest> = {}): HandoffManifest {
  return {
    version: 1,
    handoffId: 'hf-9f3a2c',
    direction: 'push',
    agentName: 'demo',
    workspacePath: '/Users/x/demo',
    wsHash: getWorkspaceScopeDirName('/Users/x/demo'),
    repo: { baseCommit: 'a41c9e0', branch: 'main', dirty: false },
    sessionId: 'sess-uuid-1',
    timeoutMinutes: 30,
    qwenVersion: '0.9.0',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('packHandoff → unpackHandoff 往返（M1 验收）', () => {
  it('输入包：manifest/repo.bundle/worktree/qwen-home 完整还原', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-pack-'));
    const repo = makeRepo();
    const bundle = join(work, 'repo.bundle');
    createFullBundle(repo, bundle);

    // 构造 worktree 与 qwen-home
    const wt = join(work, 'wt');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'x.ts'), 'export {}\n');
    const qh = join(work, 'qh', 'projects', 'demo-abc', 'chats');
    mkdirSync(qh, { recursive: true });
    writeFileSync(join(qh, 'sess-uuid-1.jsonl'), '{"type":"user","content":"hi"}\n');

    const out = join(work, 'input.tar.gz');
    await packHandoff(
      { manifest: makeManifest(), bundlePath: bundle, worktreeDir: wt, qwenHomeDir: join(work, 'qh') },
      out,
    );

    const r = await unpackHandoff(out, join(work, 'unpacked'));
    assert.equal(r.manifest.handoffId, 'hf-9f3a2c');
    assert.ok(r.bundlePath);
    assert.equal(readFileSync(join(r.worktreeDir!, 'src', 'x.ts'), 'utf8'), 'export {}\n');
    assert.match(
      readFileSync(join(r.qwenHomeDir!, 'projects', 'demo-abc', 'chats', 'sess-uuid-1.jsonl'), 'utf8'),
      /"type":"user"/,
    );
  });

  it('返回包：direction=pull + result 字段 + 无 bundle 缺省', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-pack2-'));
    const manifest = makeManifest({
      direction: 'pull',
      result: { status: 'done', commitCount: 0, newSessionIds: [], elapsedSeconds: 12 },
    });
    const out = join(work, 'output.tar.gz');
    await packHandoff({ manifest }, out);
    const r = await unpackHandoff(out, join(work, 'unpacked'));
    assert.equal(r.manifest.direction, 'pull');
    assert.equal(r.manifest.result?.status, 'done');
    assert.equal(r.bundlePath, undefined);
  });
});

describe('git bundle 增量与合并（F-3）', () => {
  it('fast-forward：本地无新提交', () => {
    const repo = makeRepo();
    const base = getRepoInfo(repo).headCommit;

    // 模拟云端：克隆后新增 commit，打增量 bundle
    const cloud = mkdtempSync(join(tmpdir(), 'ah-cloud-'));
    sh('/tmp', 'git', ['clone', repo, join(cloud, 'r')]);
    const cloudRepo = join(cloud, 'r');
    sh(cloudRepo, 'git', ['config', 'user.email', 'c@x']);
    sh(cloudRepo, 'git', ['config', 'user.name', 'cloud']);
    writeFileSync(join(cloudRepo, 'b.txt'), 'cloud\n');
    sh(cloudRepo, 'git', ['add', '.']);
    sh(cloudRepo, 'git', ['commit', '-m', 'cloud work', '--no-verify']);
    const bundle = join(cloud, 'result.bundle');
    assert.equal(createIncrementalBundle(cloudRepo, bundle, base), true);

    const r = applyResultBundle(repo, bundle, base, 'hf-9f3a2c', false);
    assert.equal(r.mode, 'fast-forward');
    assert.equal(r.newCommitCount, 1);
    assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8'), 'cloud\n');

    // 幂等：重复 apply 不产生变化
    const r2 = applyResultBundle(repo, bundle, base, 'hf-9f3a2c', false);
    assert.equal(r2.newCommitCount, 0);
  });

  it('--branch：落 agenthub/<id> 独立分支，当前分支不动', () => {
    const repo = makeRepo();
    const base = getRepoInfo(repo).headCommit;
    const cloud = mkdtempSync(join(tmpdir(), 'ah-cloud2-'));
    sh('/tmp', 'git', ['clone', repo, join(cloud, 'r')]);
    const cloudRepo = join(cloud, 'r');
    sh(cloudRepo, 'git', ['config', 'user.email', 'c@x']);
    sh(cloudRepo, 'git', ['config', 'user.name', 'cloud']);
    writeFileSync(join(cloudRepo, 'c.txt'), 'x\n');
    sh(cloudRepo, 'git', ['add', '.']);
    sh(cloudRepo, 'git', ['commit', '-m', 'w', '--no-verify']);
    const bundle = join(cloud, 'result.bundle');
    createIncrementalBundle(cloudRepo, bundle, base);

    const r = applyResultBundle(repo, bundle, base, 'hf-111111', true);
    assert.equal(r.mode, 'branch');
    assert.equal(r.branchName, 'agenthub/hf-111111');
    assert.equal(getRepoInfo(repo).headCommit, base); // 当前分支未动
    assert.equal(sh(repo, 'git', ['rev-parse', '--verify', 'agenthub/hf-111111']).length > 0, true);
  });

  it('无新 commit → createIncrementalBundle 返回 false', () => {
    const repo = makeRepo();
    const base = getRepoInfo(repo).headCommit;
    assert.equal(createIncrementalBundle(repo, join(repo, 'x.bundle'), base), false);
  });
});

describe('pack 往返边界样本（D1 验收：中文路径/空 worktree/大文件 >100MB）', () => {
  it('中文路径与文件名：逐字节还原 + manifest 全等', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-pack-zh-'));
    const wt = join(work, 'wt');
    mkdirSync(join(wt, '源码', '模块 A'), { recursive: true });
    const payload = Buffer.from('中文内容 —— emoji 🚀 特殊字符 <>&"\n');
    writeFileSync(join(wt, '源码', '模块 A', '处理器.ts'), payload);

    const manifest = makeManifest({ workspacePath: '/Users/x/中文项目' });
    const out = join(work, 'input.tar.gz');
    await packHandoff({ manifest, worktreeDir: wt }, out);
    const r = await unpackHandoff(out, join(work, 'unpacked'));

    const restored = readFileSync(join(r.worktreeDir!, '源码', '模块 A', '处理器.ts'));
    assert.equal(Buffer.compare(restored, payload), 0, '逐字节一致');
    assert.deepEqual(r.manifest, manifest, 'manifest 字段全等');
  });

  it('空 worktree（目录缺省）：往返后 worktreeDir 为 undefined', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-pack-empty-'));
    const manifest = makeManifest();
    const out = join(work, 'input.tar.gz');
    await packHandoff({ manifest }, out);
    const r = await unpackHandoff(out, join(work, 'unpacked'));
    assert.equal(r.worktreeDir, undefined);
    assert.deepEqual(r.manifest, manifest);
  });

  it('大文件 >100MB：往返后大小与内容校验一致', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-pack-big-'));
    const wt = join(work, 'wt');
    mkdirSync(wt, { recursive: true });
    // 110MB：周期性内容（非全零，避免稀疏文件误判）
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < chunk.length; i += 4) chunk.writeUInt32LE(i % 251, i);
    const bigPath = join(wt, 'big.bin');
    const fd = createWriteStream(bigPath);
    for (let i = 0; i < 110; i++) fd.write(chunk);
    await new Promise<void>((res, rej) => fd.end((e?: Error | null) => (e ? rej(e) : res())));

    const out = join(work, 'input.tar.gz');
    await packHandoff({ manifest: makeManifest(), worktreeDir: wt }, out);
    const r = await unpackHandoff(out, join(work, 'unpacked'));

    const restored = join(r.worktreeDir!, 'big.bin');
    assert.equal(statSync(restored).size, 110 * 1024 * 1024);
    // 逐字节比对用哈希（避免 220MB 内存峰值双体持有）
    const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.equal(hash(restored), hash(bigPath));
  }, 60000);
});

describe('git 合并冲突路径（D2-3 验收：有冲突保留标记）', () => {
  it('本地与云端改同一行 → conflicted=true，冲突标记保留，不静默覆盖', () => {
    const repo = makeRepo();
    const base = getRepoInfo(repo).headCommit;

    // 云端：改 a.txt 并 commit
    const cloud = mkdtempSync(join(tmpdir(), 'ah-conflict-'));
    sh('/tmp', 'git', ['clone', repo, join(cloud, 'r')]);
    const cloudRepo = join(cloud, 'r');
    sh(cloudRepo, 'git', ['config', 'user.email', 'c@x']);
    sh(cloudRepo, 'git', ['config', 'user.name', 'cloud']);
    writeFileSync(join(cloudRepo, 'a.txt'), 'cloud version\n');
    sh(cloudRepo, 'git', ['add', '.']);
    sh(cloudRepo, 'git', ['commit', '-m', 'cloud edit', '--no-verify']);
    const bundle = join(cloud, 'result.bundle');
    createIncrementalBundle(cloudRepo, bundle, base);

    // 本地：同样改 a.txt 并 commit（制造分叉冲突）
    writeFileSync(join(repo, 'a.txt'), 'local version\n');
    sh(repo, 'git', ['add', '.']);
    sh(repo, 'git', ['commit', '-m', 'local edit', '--no-verify']);

    const r = applyResultBundle(repo, bundle, base, 'hf-c0f1c7', false);
    assert.equal(r.mode, 'merge');
    assert.equal(r.conflicted, true);
    const content = readFileSync(join(repo, 'a.txt'), 'utf8');
    assert.match(content, /<{7}/, '冲突标记存在');
    assert.match(content, /local version/);
    assert.match(content, /cloud version/);
  });
});

describe('workspace 工具', () => {
  it('wsHash 规则：完整路径非字母数字替换为 -（对照真实 qwen 落盘目录）', () => {
    // 黄金样本：qwen 0.21.3 在本机为该路径实际创建的 projects 目录名
    assert.equal(
      getWorkspaceScopeDirName('/Users/gaosen/WORKSPACE/ai-competition/team-055'),
      '-Users-gaosen-WORKSPACE-ai-competition-team-055',
    );
    // 同路径稳定
    assert.equal(
      getWorkspaceScopeDirName('/Users/x/payment-gateway'),
      getWorkspaceScopeDirName('/Users/x/payment-gateway'),
    );
    // 特殊字符（含中文）全部替换为 -
    assert.equal(getWorkspaceScopeDirName('/tmp/中文 proj_1.0'), '-tmp----proj-1-0');
  });

  it('handoff id 与 OSS key 规则（§2/§3.9）', () => {
    assert.match(newHandoffId(), /^hf-[0-9a-f]{6}$/);
    assert.equal(ossKey(7, 'hf-9f3a2c', 'input.tar.gz'), 'handoffs/7/hf-9f3a2c/input.tar.gz');
  });
});
