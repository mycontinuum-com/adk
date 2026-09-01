import { defineConfig } from 'vitest/config'

/**
 * The sample sits inside the ADK repo, and Vitest walks upward looking for a config. Without this
 * file it finds the ADK's own — which points the runner at the framework's test tree, not ours.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
})
