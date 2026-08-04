import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // e2e 用例有先后依赖（push → 云端 → pull），保持文件内顺序执行
    sequence: { concurrent: false },
    testTimeout: 30000,
  },
});
