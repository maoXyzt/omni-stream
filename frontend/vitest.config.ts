import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Vitest config is kept separate from vite.config.ts so the app build doesn't
// have to pull in vitest types. Path alias mirrors tsconfig.app.json so test
// files can import via `@/...` like the rest of the app.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
})
