'use strict'

// `tsc` emits declarations that mirror `src/`, but a few entry points are published under a name
// that differs from their source path (`./stores/dynamodb` is `src/session/dynamodb.ts`). This
// writes a re-export at the published name for exactly those, so the types sit where `package.json`
// says they do.
//
// Derived from the entry table rather than listed again here: a hand-kept second list is how an
// entry ends up shipping JavaScript with no types.

const fs = require('node:fs')
const path = require('node:path')

const { ALL_ENTRIES } = require('./build-entries.cjs')

const distDir = path.join(__dirname, '..', 'dist')

/** Where `tsc` puts the declarations for a source file, given `rootDir: src` and `outDir: dist`. */
function emittedName(sourcePath) {
  return sourcePath.replace(/^src\//, '').replace(/\.tsx?$/, '')
}

const written = []

for (const [entryName, sourcePath] of Object.entries(ALL_ENTRIES)) {
  const emitted = emittedName(sourcePath)
  if (emitted === entryName) continue

  const target = path.join(distDir, `${entryName}.d.ts`)
  const emittedFile = path.join(distDir, `${emitted}.d.ts`)

  if (!fs.existsSync(emittedFile)) {
    throw new Error(
      `expected tsc to emit ${path.relative(distDir, emittedFile)} for entry "${entryName}"`,
    )
  }

  // Relative from the alias back to the real declarations, in POSIX form: a Windows separator here
  // is not a module specifier TypeScript will follow.
  const specifier = path
    .relative(path.dirname(target), emittedFile)
    .replace(/\.d\.ts$/, '')
    .split(path.sep)
    .join('/')

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(
    target,
    `export * from '${specifier.startsWith('.') ? specifier : `./${specifier}`}'\n`,
  )
  written.push(`${entryName}.d.ts`)
}

console.log(`[postbuild] Wrote ${written.length} declaration aliases: ${written.join(', ')}`)
