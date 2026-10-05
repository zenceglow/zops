import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: '/',
  resolve: {
    alias: {
      src: path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // 固定端口 + strictPort：默认行为是"端口被占就顺延到 5174/5175/5176"，
    // 于是浏览器书签指向 5173、实际服务却在 5176，改完代码看不到变化。
    // 宁可启动失败也不静默换端口（本机 5174/5175 常被 fms / shop 前端占用）。
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        // 必须写 127.0.0.1，不能写 localhost。
        // Node 17+ 的 DNS 解析顺序会把 localhost 解析成 ::1 优先，而后端
        // (axum) 只绑了 IPv4 的 0.0.0.0:5200 —— 代理去连 [::1]:5200 必然
        // ECONNREFUSED，表现为前端每个接口都 502。
        target: 'http://127.0.0.1:5200',
        ws: true,
      },
    },
  },
});
