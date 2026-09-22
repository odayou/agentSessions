import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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