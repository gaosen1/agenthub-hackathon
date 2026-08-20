import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import { HandoffManifestSchema } from './manifest.js';
import type { HandoffManifest } from './manifest.js';

/**
 * 依赖缓存失效依据（S19）：manifest/lockfile 串联内容的 sha256；
 * push 侧本地计算随 handoff 上报，worker 与 OSS sidecar 比对决定是否下发缓存。均不存在返回空串。
 */
export function computeLockHash(workspaceDir: string): string {
  const files = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];
  const h = createHash('sha256');
  let hit = false;
  for (const f of files) {
    const p = join(workspaceDir, f);
    if (!existsSync(p)) continue;
    hit = true;
    h.update(f);
    h.update('\0');
    h.update(readFileSync(p));
    h.update('\0');
  }
  return hit ? h.digest('hex') : '';
}

/** §3.1 输入包/返回包的打包与解包。
 * 打包统一走"staging 目录 → tar.gz"，布局即契约：
 *   manifest.json / repo.bundle|result.bundle / worktree/ / qwen-home/ / logs/
 */

export interface PackInput {
  manifest: HandoffManifest;
  /** repo.bundle（push）或 result.bundle（pull）的现有文件路径；pull 无新 commit 可缺省 */
  bundlePath?: string;
  /** worktree 快照目录（push） */
  worktreeDir?: string;
  /** qwen-home 目录（chats + settings） */
  qwenHomeDir?: string;
  /** logs 目录（pull） */
  logsDir?: string;
}

/** 打包 handoff 包到 outPath（.tar.gz）；staging 于 outPath 同目录 */
export async function packHandoff(input: PackInput, outPath: string): Promise<void> {
  const manifest = HandoffManifestSchema.parse(input.manifest);
  const staging = `${outPath}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const bundleName = manifest.direction === 'push' ? 'repo.bundle' : 'result.bundle';
    if (input.bundlePath) cpSync(input.bundlePath, join(staging, bundleName));
    if (input.worktreeDir) cpSync(input.worktreeDir, join(staging, 'worktree'), { recursive: true });
    if (input.qwenHomeDir) cpSync(input.qwenHomeDir, join(staging, 'qwen-home'), { recursive: true });
    if (input.logsDir) cpSync(input.logsDir, join(staging, 'logs'), { recursive: true });

    await tar.create({ gzip: true, file: outPath, cwd: staging, portable: true }, ['.']);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface UnpackResult {
  manifest: HandoffManifest;
  /** 解包根目录（含 §3.1 布局） */
  dir: string;
  bundlePath?: string;
  worktreeDir?: string;
  qwenHomeDir?: string;
  logsDir?: string;
}

/** 解包到 targetDir 并校验 manifest */
export async function unpackHandoff(tarPath: string, targetDir: string): Promise<UnpackResult> {
  mkdirSync(targetDir, { recursive: true });
  await tar.extract({ file: tarPath, cwd: targetDir });

  const manifestPath = join(targetDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`包内缺少 manifest.json: ${tarPath}`);
  const manifest = HandoffManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  const bundleName = manifest.direction === 'push' ? 'repo.bundle' : 'result.bundle';
  const opt = (p: string) => (existsSync(join(targetDir, p)) ? join(targetDir, p) : undefined);
  return {
    manifest,
    dir: targetDir,
    bundlePath: opt(bundleName),
    worktreeDir: opt('worktree'),
    qwenHomeDir: opt('qwen-home'),
    logsDir: opt('logs'),
  };
}

/**
 * push 用 worktree 快照（§3.1）：未提交变更 + 白名单未跟踪文件，遵循 .gitignore，不含 .git/
 * 实现：git ls-files（改动 + 未跟踪未忽略）逐个拷贝
 */
export function snapshotWorktree(repoRoot: string, targetDir: string, includeUntracked: boolean): string[] {
  const args = ['ls-files', '--modified', '--others', '--exclude-standard'];
  if (!includeUntracked) args.splice(2, 1); // 去掉 --others：只要已跟踪的改动
  const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  const files = [...new Set(out.split('\n').filter((f) => f.trim().length > 0))];
  for (const f of files) {
    const src = join(repoRoot, f);
    if (!existsSync(src)) continue; // 已删除文件跳过（体现在 git status，pull 侧走 merge）
    const dst = join(targetDir, f);
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(src, dst);
  }
  return files;
}
