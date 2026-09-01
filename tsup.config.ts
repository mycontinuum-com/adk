import { defineConfig, type Options } from 'tsup'

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { MAIN_ENTRIES, SUBPATH_ENTRIES, type EntryMap } from './scripts/build-entries.cjs'

/** Esbuild's own plugin type, reached through tsup so esbuild need not be a direct dependency. */
type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number]

const allExternal = [
  'zod',
  'openai',
  'openai/helpers/zod',
  'openai/resources/responses/responses',
  '@google/genai',
  '@anthropic-ai/vertex-sdk',
  '@anthropic-ai/claude-agent-sdk',
  '@modelcontextprotocol/sdk',
  '@ag-ui/core',
  'react',
  'ink',
  'ink-text-input',

  '@mozilla/readability',
  'jsdom',
  'turndown',
  'playwright',
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/lib-dynamodb',
  '@aws-sdk/client-sagemaker-runtime',
  'pg',
  '@livekit/agents',
  '@livekit/agents-plugin-openai',
  '@livekit/agents-plugin-google',
  '@livekit/rtc-node',
  '@livekit/noise-cancellation-node',
  'livekit-server-sdk',
  'voyageai',
  '@qdrant/js-client-rest',

  'sharp',
  'pdf-lib',
  'ws',
]

const esmRequireShim: EsbuildPlugin = {
  name: 'esm-require-shim',
  setup(build) {
    if (build.initialOptions.format === 'esm') {
      build.initialOptions.banner = {
        js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
      }
    }
  },
}

const externalizeHeavyModules: EsbuildPlugin = {
  name: 'externalize-heavy-modules-from-main',
  setup(build) {
    const formatExt = build.initialOptions.format === 'cjs' ? '.js' : '.mjs'
    const ext = (kind: string) => (kind === 'require-call' ? '.js' : formatExt)

    build.onResolve({ filter: /^\.\.\/cli(\/index)?$/ }, (args) => {
      if (args.importer.includes('api/app') || args.importer.includes('api\\app')) {
        return { path: `./cli/index${ext(args.kind)}`, external: true }
      }
    })
    build.onResolve({ filter: /^\.\.\/agui\/adapter$/ }, (args) => {
      if (args.importer.includes('handler/agui') || args.importer.includes('handler\\agui')) {
        return { path: `./agui/index${ext(args.kind)}`, external: true }
      }
    })
    build.onResolve({ filter: /^\.\.\/web\/tools$/ }, (args) => {
      if (args.importer.includes('api/app') || args.importer.includes('api\\app')) {
        return { path: `./web/index${ext(args.kind)}`, external: true }
      }
    })
    build.onResolve({ filter: /^\.\.\/voice$/ }, (args) => {
      if (args.importer.includes('api/app') || args.importer.includes('api\\app')) {
        return { path: `./voice/index${ext(args.kind)}`, external: true }
      }
    })
    build.onResolve({ filter: /^\.\.\/eval\/voice\/evaluate$/ }, (args) => {
      if (args.importer.includes('api/app') || args.importer.includes('api\\app')) {
        return { path: `./eval/index${ext(args.kind)}`, external: true }
      }
    })
  },
}

// Declarations are NOT built here. tsup runs one rollup-plugin-dts pass per config, so nine configs
// meant nine TypeScript programs over the same source tree: ~2.6 GB peak, which is over the heap a
// 7 GB CI runner gives a worker. `tsc --emitDeclarationOnly` builds one program for the whole
// package instead, at ~0.6 GB, and the cost stops scaling with the number of entry points.
// `splitting` is deliberately unset: tsup's default splits the ESM output, so a source-level
// `await import()` of a provider adapter stays a lazy chunk instead of hoisting the provider
// SDK's static import to the entry's top level — importing the core must not require optional
// peers. CJS stays unsplit (esbuild wraps its lazy requires without splitting).
const shared: Partial<Options> = {
  format: ['cjs', 'esm'],
  dts: false,
  sourcemap: true,
}

function subpath(entry: EntryMap, bundled: readonly string[]): Options {
  return {
    ...shared,
    entry,
    external: allExternal.filter((d) => !bundled.includes(d)),
    noExternal: [...bundled],
    esbuildPlugins: [esmRequireShim],
  }
}

export default defineConfig(() => [
  {
    ...shared,
    entry: MAIN_ENTRIES,
    external: allExternal,
    esbuildPlugins: [esmRequireShim, externalizeHeavyModules],
  },
  ...SUBPATH_ENTRIES.map(([entry, bundled]) => subpath(entry, bundled)),
])
