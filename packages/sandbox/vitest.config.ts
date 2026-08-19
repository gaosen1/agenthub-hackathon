import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/sandbox-dist/**',
      '**/{karma,jest,vitest}.config.*',
    ],
  },
});
