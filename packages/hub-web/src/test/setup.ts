import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';

// 显式 extend 测试侧 expect，避免 '/vitest' 入口在外部化依赖下注册到别的 expect 实例
expect.extend(matchers);

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
});
