/**
 * 系统 tar 封装（S20）：创建优先 zstd、不可用自动降级 gzip；解压自动识别格式。
 * npm tar 库仅 gzip；大包体积与速度靠 zstd，两侧（本地 Mac bsdtar / Pod GNU tar+zstd）均支持。
 */
import { execFileSync } from 'node:child_process';

let zstdOk: boolean | undefined;

/** 探测本地 tar 是否支持 --zstd */
export function tarZstdSupported(): boolean {
  if (zstdOk !== undefined) return zstdOk;
  try {
    execFileSync('tar', ['--zstd', '-cf', '/dev/null', '--files-from', '/dev/null'], { stdio: 'pipe' });
    zstdOk = true;
  } catch {
    zstdOk = false;
  }
  return zstdOk;
}

/** 创建 tar：优先 zstd，不可用降级 gzip */
export function tarCreate(file: string, cwd: string, entries: string[]): void {
  const args = tarZstdSupported() ? ['--zstd', '-cf', file] : ['-czf', file];
  execFileSync('tar', [...args, '-C', cwd, '--', ...entries], { stdio: 'pipe' });
}

/** 解压 tar：自动识别 gzip/zstd（兼容两侧旧包） */
export function tarExtract(file: string, cwd: string): void {
  execFileSync('tar', ['-xf', file, '-C', cwd], { stdio: 'pipe' });
}
