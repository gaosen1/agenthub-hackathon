import { createHash, randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';

/**
 * qwen 的 getWorkspaceScopeDirName 等价实现（design.md §6.1）：
 * 净化 basename（≤32 字符）+ '-' + sha256(canonical path) 前 12 位
 */
export function getWorkspaceScopeDirName(workspacePath: string): string {
  const canonical = resolve(workspacePath);
  const sanitized = basename(canonical)
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .slice(0, 32);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${sanitized}-${hash}`;
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
