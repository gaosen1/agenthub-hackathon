import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import { tarCreate, tarExtract, tarZstdSupported } from './tartool.js';

describe('tartool（S20 zstd 压缩）', () => {
  it('创建+解压 roundtrip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-tar-'));
    const out = mkdtempSync(join(tmpdir(), 'ah-tar-out-'));
    writeFileSync(join(dir, 'a.txt'), 'hello-zstd');
    const file = join(tmpdir(), `ah-${Date.now()}.tar.zst`);
    tarCreate(file, dir, ['a.txt']);
    tarExtract(file, out);
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('hello-zstd');
    rmSync(file, { force: true });
  });

  it('兼容 gzip 旧包（npm tar 创建）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-tar-'));
    const out = mkdtempSync(join(tmpdir(), 'ah-tar-out-'));
    writeFileSync(join(dir, 'b.txt'), 'legacy-gzip');
    const file = join(tmpdir(), `ah-${Date.now()}.tar.gz`);
    await tar.c({ file, cwd: dir, gzip: true }, ['b.txt']);
    tarExtract(file, out);
    expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('legacy-gzip');
    rmSync(file, { force: true });
  });

  it('zstd 探测返回布尔', () => {
    expect(typeof tarZstdSupported()).toBe('boolean');
    // 本地 Mac bsdtar 原生支持；Pod 镜像已装 zstd
    if (process.platform === 'darwin') expect(tarZstdSupported()).toBe(true);
  });

  it('系统 tar 可用', () => {
    expect(() => execFileSync('tar', ['--version'], { stdio: 'pipe' })).not.toThrow();
  });
});
