import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * qwen 真实实现（packages/core/src/utils/paths.ts 的 sanitizeCwd，已对照 0.21.3 源码与
 * ~/.qwen/projects/ 实际目录验证）：完整绝对路径逐字符把非字母数字替换为 '-'，
 * Windows 下先转小写。注意：design.md §6.1 描述的 basename+sha256 方案与真实实现不符。
 */
export function getWorkspaceScopeDirName(workspacePath: string): string {
  const canonical = resolve(workspacePath);
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/** §2 ID 规则：handoff id = hf- + 6 位 hex */
export function newHandoffId(): string {
  return `hf-${randomBytes(3).toString('hex')}`;
}

/** §2 ID 规则：snapshot id = snap- + 6 位 hex */
export function newSnapshotId(): string {
  return `snap-${randomBytes(3).toString('hex')}`;
}

/** §3.9 OSS key */
export function ossKey(userId: number | string, handoffId: string, file: 'input.tar.gz' | 'output.tar.gz'): string {
  return `handoffs/${userId}/${handoffId}/${file}`;
}
