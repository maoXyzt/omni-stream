import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // rust-embed reads `frontend/dist/`; this path is relative to vite.config.ts.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // During `pnpm dev`, forward /api/* to the Rust backend on :8080.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
})
