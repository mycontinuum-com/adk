import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
    'testing/index': 'src/testing/index.ts',
    'persistence/index': 'src/persistence/index.ts',
    'web/index': 'src/web/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    'openai',
    '@google/genai',
    '@anthropic-ai/vertex-sdk',
    'react',
    'ink',
    'ink-spinner',
    'ink-text-input',
    'better-sqlite3',
    '@mozilla/readability',
    'jsdom',
    'turndown',
    'playwright',
  ],
});
