import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeLockHash } from './pack.js';

describe('computeLockHash（S19 依赖缓存失效依据）', () => {
  it('无 manifest/lockfile 返回空串', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-lock-'));
    expect(computeLockHash(dir)).toBe('');
  });

  it('lockfile 变化即变；无关文件不影响', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-lock-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    const h1 = computeLockHash(dir);
    expect(h1.length).toBeGreaterThan(0);
    writeFileSync(join(dir, 'unrelated.txt'), 'zzz');
    expect(computeLockHash(dir)).toBe(h1);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    expect(computeLockHash(dir)).not.toBe(h1);
  });
});
