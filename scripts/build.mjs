// Bundles the JavaScript for every public entry point as CommonJS (`.js`) and ESM (`.mjs`).
// Declarations are NOT built here: `tsc --emitDeclarationOnly` builds one program for the whole
// package, so the cost does not scale with the number of entry points.
// ESM output is split, so a source-level `await import()` of a provider adapter stays a lazy chunk
// instead of hoisting the provider SDK's static import to the entry's top level — importing the
// core must not require optional peers. CJS stays unsplit (esbuild wraps its lazy requires).
//
//   node scripts/build.mjs           build dist/
//   node scripts/build.mjs --watch   rebuild on change

import { context } from 'esbuild'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { MAIN_ENTRIES, SUBPATH_ENTRIES } = require('./build-entries.cjs')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Installed by the consumer (dependencies and peers) or deliberately left to the host. */
const allExternal = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
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

/** A package, or a subpath of it, that `bundled` pulls into the output. */
const isBundled = (name, bundled) =>
  bundled.some((b) => name === b || name.startsWith(`${b}/`) || b.startsWith(`${name}/`))

// The main entries import these heavy modules lazily; each resolves to its own published entry
// instead of being inlined into the importer.
const HEAVY_MODULES = [
  [/^\.\.\/terminal(\/index)?$/, 'api/app', 'terminal'],
  [/^\.\.\/agui\/adapter$/, 'handler/agui', 'agui'],
  [/^\.\.\/web\/tools$/, 'api/app', 'web'],
  [/^\.\.\/voice$/, 'api/app', 'voice'],
  [/^\.\.\/eval\/voice\/evaluate$/, 'api/app', 'eval'],
]

const externalizeHeavyModules = {
  name: 'externalize-heavy-modules-from-main',
  setup(build) {
    const formatExt = build.initialOptions.format === 'cjs' ? '.js' : '.mjs'
    const ext = (kind) => (kind === 'require-call' ? '.js' : formatExt)
    for (const [filter, importer, entry] of HEAVY_MODULES) {
      const importerWindows = importer.replace('/', '\\')
      build.onResolve({ filter }, (args) => {
        if (args.importer.includes(importer) || args.importer.includes(importerWindows)) {
          return { path: `./${entry}/index${ext(args.kind)}`, external: true }
        }
      })
    }
  },
}

const ESM_REQUIRE_SHIM = `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`

const builds = [
  { entryPoints: MAIN_ENTRIES, bundled: [], plugins: [externalizeHeavyModules] },
  ...SUBPATH_ENTRIES.map(([entryPoints, bundled]) => ({ entryPoints, bundled, plugins: [] })),
].flatMap(({ entryPoints, bundled, plugins }) => {
  const shared = {
    entryPoints,
    outdir: 'dist',
    bundle: true,
    platform: 'node',
    target: 'es2022',
    tsconfig: 'tsconfig.json',
    mainFields: ['module', 'main'],
    sourcemap: true,
    external: [...new Set(allExternal)].filter((name) => !isBundled(name, bundled)),
    plugins,
    logLevel: 'warning',
  }
  return [
    { ...shared, format: 'cjs', outExtension: { '.js': '.js' } },
    {
      ...shared,
      format: 'esm',
      splitting: true,
      outExtension: { '.js': '.mjs' },
      banner: { js: ESM_REQUIRE_SHIM },
    },
  ]
})

const contexts = await Promise.all(builds.map((options) => context(options)))
if (process.argv.includes('--watch')) {
  await Promise.all(contexts.map((ctx) => ctx.watch()))
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()))
  await Promise.all(contexts.map((ctx) => ctx.dispose()))
}
