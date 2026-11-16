import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'))

export default defineConfig({
  cacheDir: 'node_modules/.vite/adk',
  define: { __ADK_VERSION__: JSON.stringify(version) },
  test: {
    root: './src',
    globals: true,
    setupFiles: ['./testing/setup.ts'],
    testTimeout: 100000,
  },
})
