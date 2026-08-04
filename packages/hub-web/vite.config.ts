import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// hub-server 开发期在 3000 端口，/api 走代理
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
