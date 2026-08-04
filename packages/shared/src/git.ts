import { execFileSync } from 'node:child_process';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface RepoInfo {
  root: string;
  branch: string;
  headCommit: string;
  dirty: boolean;
}

export function getRepoInfo(cwd: string): RepoInfo {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headCommit = git(root, ['rev-parse', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain']).length > 0;
  return { root, branch, headCommit, dirty };
}

/** §3.1 输入包 repo.bundle：首次全量 */
export function createFullBundle(repoRoot: string, bundlePath: string): void {
  git(repoRoot, ['bundle', 'create', bundlePath, '--all']);
}

/** §3.1 返回包 result.bundle：baseCommit..HEAD 增量；无新 commit 返回 false（缺省该文件） */
export function createIncrementalBundle(repoRoot: string, bundlePath: string, baseCommit: string): boolean {
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  if (head === baseCommit) return false;
  git(repoRoot, ['bundle', 'create', bundlePath, `${baseCommit}..HEAD`]);
  return true;
}

/** bundle → 本地仓库还原（云端 runner 用）：clone --all bundle */
export function cloneFromBundle(bundlePath: string, targetDir: string, branch: string): void {
  execFileSync('git', ['clone', bundlePath, targetDir], { encoding: 'utf8' });
  git(targetDir, ['checkout', branch]);
}

export type PullMergeMode = 'fast-forward' | 'merge' | 'branch';

export interface ApplyBundleResult {
  mode: PullMergeMode;
  /** merge 模式下是否有冲突（冲突保留标记，不静默覆盖） */
  conflicted: boolean;
  /** branch 模式落地的分支名 */
  branchName?: string;
  newCommitCount: number;
}

/**
 * F-3 代码合并策略：fetch result.bundle 后按本地状态选择
 * - 本地 HEAD == baseCommit → fast-forward
 * - 本地有新提交 → merge（冲突保留标记）
 * - toBranch=true → 只落独立分支 agenthub/<handoffId>，不动当前分支
 * 幂等：云端 head 已在本地历史中 → newCommitCount=0 直接返回
 */
export function applyResultBundle(
  repoRoot: string,
  bundlePath: string,
  baseCommit: string,
  handoffId: string,
  toBranch: boolean,
): ApplyBundleResult {
  // bundle 里的 HEAD 引用即云端 HEAD
  git(repoRoot, ['bundle', 'verify', bundlePath]);
  git(repoRoot, ['fetch', bundlePath, 'HEAD:refs/agenthub/incoming']);
  const cloudHead = git(repoRoot, ['rev-parse', 'refs/agenthub/incoming']);
  const localHead = git(repoRoot, ['rev-parse', 'HEAD']);

  const newCommitCount = Number(git(repoRoot, ['rev-list', '--count', `${baseCommit}..${cloudHead}`]));

  // 幂等：云端 head 已可从本地 HEAD 到达
  const alreadyMerged = (() => {
    try {
      git(repoRoot, ['merge-base', '--is-ancestor', cloudHead, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  })();
  if (alreadyMerged) {
    git(repoRoot, ['update-ref', '-d', 'refs/agenthub/incoming']);
    return { mode: 'merge', conflicted: false, newCommitCount: 0 };
  }

  if (toBranch) {
    const branchName = `agenthub/${handoffId}`;
    git(repoRoot, ['branch', '-f', branchName, cloudHead]);
    git(repoRoot, ['update-ref', '-d', 'refs/agenthub/incoming']);
    return { mode: 'branch', conflicted: false, branchName, newCommitCount };
  }

  if (localHead === baseCommit) {
    git(repoRoot, ['merge', '--ff-only', cloudHead]);
    git(repoRoot, ['update-ref', '-d', 'refs/agenthub/incoming']);
    return { mode: 'fast-forward', conflicted: false, newCommitCount };
  }

  // 本地有新提交 → merge，冲突时保留标记返回
  let conflicted = false;
  try {
    git(repoRoot, ['merge', '--no-ff', '--no-edit', cloudHead, '-m', `AgentHub: merge cloud commits of ${handoffId}`]);
  } catch {
    conflicted = true;
  }
  git(repoRoot, ['update-ref', '-d', 'refs/agenthub/incoming']);
  return { mode: 'merge', conflicted, newCommitCount };
}
