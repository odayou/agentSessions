import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from '../package.json'

export default defineConfig({
  plugins: [react()],
  // 注入根 package.json 版本号：浏览器 dev 模式下无法调 Tauri API 取版本（lib.tsx getAppVersion）
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    // 端口可经环境变量覆盖（scripts/tauri.cjs 自动探测空闲端口时注入），默认 5173
    port: Number(process.env.AGENTSSESSIONS_PORT) || 5173,
    // 端口被占直接报错退出，禁止静默换端口（否则 Tauri 壳仍连 devUrl，会串到别的项目页面）
    strictPort: true,
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