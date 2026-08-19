import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  TERMINAL_STATUSES,
  applyResultBundle,
  getRepoInfo,
  mergeSessionJsonlFile,
  unpackHandoff,
} from '@agenthub/shared';
import { HubClient, downloadFromSignedUrl } from './api.js';
import { loadConfig } from './config.js';
import { chatsDir, sessionPath } from './qwen.js';

export interface PullOptions {
  branch?: boolean;
}

/** F-2 agenthub pull：查状态 → 下载返回包 → 代码合并（F-3）→ 会话合并（F-4）→ 摘要 */
export async function runPull(handoffId: string | undefined, opts: PullOptions): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.token) throw new Error('未登录，请先执行 agenthub login');
  const client = new HubClient(cfg);

  const repo = getRepoInfo(process.cwd());
  const workspacePath = repo.root;

  // 缺省：当前仓库最近一次已终态任务
  let id = handoffId;
  if (!id) {
    const list = await client.listHandoffs({ agentName: basename(workspacePath) });
    const latest = list.items.find((h) => (TERMINAL_STATUSES as readonly string[]).includes(h.status));
    if (!latest) throw new Error('当前仓库没有可拉取的已完成任务');
    id = latest.id;
  }

  // F-3：本地有未提交变更时强制提示（--branch 落独立分支不受影响）
  if (repo.dirty && !opts.branch) {
    throw new Error('本地有未提交变更，请先 stash 或 commit 后再 pull（或使用 --branch 落独立分支）');
  }

  const intent = await client.pullIntent(id);
  const manifest = intent.manifest;
  console.log(`✓ ${id} 已到终态（${manifest.result?.status ?? 'done'}），开始下载返回包`);

  const staging = mkdtempSync(join(tmpdir(), 'agenthub-pull-'));
  try {
    const tarPath = join(staging, 'output.tar.gz');
    await downloadFromSignedUrl(intent.downloadUrl, tarPath);
    const pkg = await unpackHandoff(tarPath, join(staging, 'unpacked'));

    // —— 代码合并（F-3）——
    let codeSummary = '云端无新 commit';
    if (pkg.bundlePath) {
      const r = applyResultBundle(
        workspacePath,
        pkg.bundlePath,
        manifest.repo.baseCommit,
        manifest.handoffId,
        opts.branch ?? false,
      );
      if (r.newCommitCount === 0) codeSummary = '云端 commit 已在本地（重复 pull，跳过）';
      else if (r.mode === 'branch') codeSummary = `${r.newCommitCount} 个云端 commit 落到分支 ${r.branchName}`;
      else if (r.conflicted) codeSummary = `merge 有冲突，请解决后 git commit（冲突标记已保留）`;
      else codeSummary = `${r.newCommitCount} 个云端 commit 已合并（${r.mode}）`;
    }

    // —— 会话合并（F-4）——
    const sessionSummaries: string[] = [];
    const cloudChats = pkg.qwenHomeDir ? join(pkg.qwenHomeDir, 'projects', manifest.wsHash, 'chats') : undefined;
    if (cloudChats && existsSync(cloudChats)) {
      for (const f of readdirSync(cloudChats).filter((f) => f.endsWith('.jsonl'))) {
        const sid = f.replace(/\.jsonl$/, '');
        const cloudPath = join(cloudChats, f);
        const localPath = sessionPath(workspacePath, sid);
        if (sid === manifest.sessionId && existsSync(localPath)) {
          // 移交的 session 走时间线合并
          const r = mergeSessionJsonlFile(localPath, cloudPath, manifest.handoffId);
          if (r.skipped) sessionSummaries.push(`session ${sid}: 已合并过（幂等跳过）`);
          else
            sessionSummaries.push(
              `session ${sid}: +${r.mergedCount} 条云端记录${r.forked ? '（分叉交错合并）' : ''}，备份 ${basename(r.backupPath!)}`,
            );
        } else if (!existsSync(localPath)) {
          // 云端新 session（bot 各群）直接落盘
          mkdirSync(chatsDir(workspacePath), { recursive: true });
          copyFileSync(cloudPath, localPath);
          sessionSummaries.push(`session ${sid}: 云端新会话，已落盘`);
        }
      }
    }

    // —— 摘要 ——
    console.log('\n===== pull 摘要 =====');
    console.log(`代码: ${codeSummary}`);
    for (const s of sessionSummaries) console.log(`会话: ${s}`);
    if (manifest.result) {
      console.log(
        `执行: ${manifest.result.status}，${manifest.result.commitCount} commits，耗时 ${manifest.result.elapsedSeconds}s${manifest.result.tokensUsed ? `，tokens ${manifest.result.tokensUsed}` : ''}`,
      );
      if (manifest.result.error) console.log(`错误: ${manifest.result.error}`);
    }
    console.log(`\n现在可以在本地执行 qwen 打开 session 续聊。`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
