import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  appendHandoffMarker,
  computeLockHash,
  createFullBundle,
  getRepoInfo,
  getWorkspaceScopeDirName,
  packHandoff,
  snapshotWorktree,
} from '@agenthub/shared';
import type { CreateHandoffReq, HandoffManifest } from '@agenthub/shared';
import { HubClient, uploadToSignedUrl } from './api.js';
import { loadConfig } from './config.js';
import { latestSessionId, qwenVersion, sanitizedSettings, sessionPath } from './qwen.js';

export interface PushOptions {
  session?: string;
  task?: string;
  includeUntracked?: boolean;
  bot?: string;
  chat?: string;
  timeout?: string;
}

/** F-1 agenthub push：打包 → 创建 handoff → OSS 直传 → 上传回执 */
export async function runPush(opts: PushOptions): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.token) throw new Error('未登录，请先执行 agenthub login');
  const client = new HubClient(cfg);

  const repo = getRepoInfo(process.cwd());
  const workspacePath = repo.root;
  const agentName = basename(workspacePath);
  const wsHash = getWorkspaceScopeDirName(workspacePath);

  const sessionId = opts.session ?? latestSessionId(workspacePath);
  if (!sessionId) throw new Error(`未找到可移交的 session（workspace: ${workspacePath}），可用 --session 指定`);
  const sessPath = sessionPath(workspacePath, sessionId);
  if (!existsSync(sessPath)) throw new Error(`session 文件不存在: ${sessPath}`);

  // 1. 创建 handoff 拿 id + 上传签名 URL（--bot 传名字，先解析为 botId）
  let botId: number | undefined;
  if (opts.bot) {
    const { items } = await client.listBots();
    const bot = items.find((b) => b.name === opts.bot && b.status !== 'deleted');
    if (!bot) throw new Error(`机器人 "${opts.bot}" 不存在，先在 Web 面板创建（现有: ${items.map((b) => b.name).join(', ') || '无'}）`);
    botId = bot.id;
  }
  const req: CreateHandoffReq = {
    agentName,
    workspacePath,
    wsHash,
    sessionId,
    baseCommit: repo.headCommit,
    branch: repo.branch,
    task: opts.task,
    kind: opts.bot ? 'bot' : 'web',
    botId,
    bindChatId: opts.chat,
    timeoutMinutes: opts.timeout ? Number(opts.timeout) : 30,
    // S19 依赖缓存：lockfile 哈希随 handoff 上报，worker 与 OSS sidecar 比对
    ...(computeLockHash(workspacePath) ? { depsLockHash: computeLockHash(workspacePath) } : {}),
  };
  const created = await client.createHandoff(req);
  console.log(`✓ handoff 创建: ${created.handoffId}`);

  // 2. 本地 session 末尾写 handoff_marker（§3.3），随后的拷贝自然带上
  const marker = appendHandoffMarker(sessPath, created.handoffId, repo.headCommit);
  console.log(`✓ handoff_marker 写入（前缀 ${marker.messageCount} 条）`);

  // 3. staging：repo.bundle + worktree 快照 + qwen-home
  const staging = mkdtempSync(join(tmpdir(), 'agenthub-push-'));
  try {
    const bundlePath = join(staging, 'repo.bundle');
    createFullBundle(workspacePath, bundlePath);

    // 缺省含未跟踪文件：新写但未 git add 的文件正是接力最需要带上的。
    // 优先级（S21）：--no-include-untracked 显式关 > 本地 config > 服务端设置 > 缺省 true
    const server = await client.getServerSettings();
    const includeUntracked = opts.includeUntracked === false ? false : (cfg.includeUntracked ?? server?.includeUntracked ?? true);
    let worktreeDir: string | undefined;
    if (repo.dirty || includeUntracked) {
      worktreeDir = join(staging, 'worktree');
      mkdirSync(worktreeDir, { recursive: true });
      const files = snapshotWorktree(workspacePath, worktreeDir, includeUntracked);
      console.log(`✓ worktree 快照 ${files.length} 个文件`);
    }

    const qwenHomeDir = join(staging, 'qwen-home');
    const chatsTarget = join(qwenHomeDir, 'projects', wsHash, 'chats');
    mkdirSync(chatsTarget, { recursive: true });
    copyFileSync(sessPath, join(chatsTarget, `${sessionId}.jsonl`));
    const settings = sanitizedSettings();
    if (settings) writeFileSync(join(qwenHomeDir, 'settings.json'), settings);

    const manifest: HandoffManifest = {
      version: 1,
      handoffId: created.handoffId,
      direction: 'push',
      agentName,
      workspacePath,
      wsHash,
      repo: { baseCommit: repo.headCommit, branch: repo.branch, dirty: repo.dirty },
      sessionId,
      task: opts.task,
      timeoutMinutes: req.timeoutMinutes,
      qwenVersion: qwenVersion(),
      createdAt: new Date().toISOString(),
    };

    const tarPath = join(staging, 'input.tar.gz');
    await packHandoff({ manifest, bundlePath, worktreeDir, qwenHomeDir }, tarPath);

    // 4. OSS 直传 + 回执
    await uploadToSignedUrl(created.uploadUrl, tarPath);
    await client.markUploaded(created.handoffId);
    console.log(`✓ 输入包已上传，任务入队`);
    console.log(`\nhandoff: ${created.handoffId}`);
    console.log(`web:     ${created.webUrl}`);
    if (opts.task) console.log(`task:    ${opts.task}`);
    else console.log(`模式:    交互接力（云端挂起等待 Web/钉钉对话）`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
