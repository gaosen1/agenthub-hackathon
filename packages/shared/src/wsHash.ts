/**
 * workspace hash（qwen 的 getWorkspaceScopeDirName 算法，spec §6.1 路径一致性）
 * = 净化 basename(≤32) + '-' + sha256(canonical path) 前 12 位
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export function getWorkspaceScopeDirName(workspacePath: string): string {
  const canonical = workspacePath.replace(/\/+$/, '');
  const name = basename(canonical)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 32);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${name}-${hash}`;
}
