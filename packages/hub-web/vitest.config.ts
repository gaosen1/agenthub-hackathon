import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // dataSource 是 client.ts 里的 module 级可变量，隔离文件避免跨用例污染
    isolate: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/{vite,vitest}.config.*'],
  },
});
