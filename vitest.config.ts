import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: 'node_modules/.vite/adk',
  test: {
    root: './src',
    globals: true,
    setupFiles: ['./testing/setup.ts'],
    testTimeout: 100000,
  },
})
