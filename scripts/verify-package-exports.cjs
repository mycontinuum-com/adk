'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  }),
)[0]

const packedPaths = new Set(packed.files.map((file) => file.path))
const missing = []

for (const target of Object.values(pkg.exports)) {
  if (!target || typeof target !== 'object') {
    continue
  }

  for (const key of ['types', 'import', 'require']) {
    const value = target[key]
    if (typeof value !== 'string') {
      continue
    }

    const normalized = value.replace(/^\.\//, '')
    if (!packedPaths.has(normalized)) {
      missing.push(normalized)
    }
  }
}

if (missing.length > 0) {
  console.error('Missing export targets from npm pack:')
  for (const file of missing) {
    console.error(`- ${file}`)
  }
  process.exit(1)
}

console.log(`Verified ${packedPaths.size} packed files cover all export targets.`)

// The key-free entries must load with nothing installed beyond required deps: a bundler change
// that hoists a lazy provider import to a static one (the class that shipped a main entry needing
// `openai` and `@ag-ui/core`) is invisible to the monorepo test suite, where every devDep exists,
// so it is caught here by walking each entry's ESM output and every chunk it statically reaches.
const { builtinModules } = require('module')
const KEY_FREE_ENTRIES = ['.', './testing']

const builtins = new Set(builtinModules)
const optionalPeers = new Set(
  Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta && meta.optional === true)
    .map(([name]) => name),
)
const allowed = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name)),
])

const staticImportRe =
  /^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm

const packageOf = (spec) => {
  const name = spec.startsWith('node:') ? spec.slice(5) : spec
  return name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
}

const staticViolations = []
for (const entry of KEY_FREE_ENTRIES) {
  const entryFile = pkg.exports[entry] && pkg.exports[entry].import
  if (typeof entryFile !== 'string') {
    staticViolations.push(`${entry}: no ESM export target to scan`)
    continue
  }
  const queue = [path.join(root, entryFile)]
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(staticImportRe)) {
      const spec = match[1] ?? match[2]
      if (spec.startsWith('.')) {
        // Follow only specs that resolve to real files: a non-resolving "import" line is codegen
        // text inside a template literal, not a module edge (relative imports in tsup output
        // always carry their extension).
        const resolved = path.resolve(path.dirname(file), spec)
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) queue.push(resolved)
        continue
      }
      const base = packageOf(spec)
      if (builtins.has(base)) continue
      if (!allowed.has(base)) {
        staticViolations.push(
          `${entry}: static import of optional/undeclared "${spec}" via ${path.relative(root, file)}`,
        )
      }
    }
  }
}

if (staticViolations.length > 0) {
  console.error('Key-free entries statically import packages a bare install will not have:')
  for (const violation of staticViolations) {
    console.error(`- ${violation}`)
  }
  process.exit(1)
}

console.log(`Verified ${KEY_FREE_ENTRIES.join(', ')} load without optional dependencies.`)
