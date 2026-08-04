import { defineConfig } from 'vitest/config';

// D1 验收：shared 单测覆盖率 ≥ 80%（行）
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80 },
    },
  },
});
