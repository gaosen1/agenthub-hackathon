import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// hub-server 开发期默认 4180 端口（HUB_PORT），/api 走代理
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4180',
    },
  },
});
