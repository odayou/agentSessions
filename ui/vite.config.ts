import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from '../package.json'

export default defineConfig({
  plugins: [react()],
  // 注入根 package.json 版本号：浏览器 dev 模式下无法调 Tauri API 取版本（lib.tsx getAppVersion）
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5173,
    // 开发期代理到本地 REST 桥，避免 CORS
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:18778',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist' },
})