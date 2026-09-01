import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The testing barrel is ALSO a production-adjacent surface: release harnesses drive its
 * deterministic mock runner (`runTest`/`user`/`model`) under plain node, where importing 'vitest'
 * throws at module init ("Vitest failed to access its internal state"). That import reached the
 * barrel through the matchers re-export and errored all 72 deterministic activation cases in the
 * deployed clinical-intelligence release task (2026-08-02) — invisible to every vitest-run suite,
 * because inside a vitest worker the import succeeds. This walks the barrel's STATIC import graph
 * so the class fails here, in CI, instead of in a deployed one-shot task.
 */

const testingRoot = dirname(fileURLToPath(import.meta.url))

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g

function moduleFile(fromDir: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(fromDir, specifier)
  for (const candidate of [base + '.ts', resolve(base, 'index.ts')]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // try the next shape
    }
  }
  throw new Error(`unresolvable relative import "${specifier}" from ${fromDir}`)
}

function staticGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (graph.has(file)) continue
    const source = readFileSync(file, 'utf8')
    const bareImports: string[] = []
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1]!
      const resolved = moduleFile(dirname(file), specifier)
      if (resolved === null) bareImports.push(specifier)
      else queue.push(resolved)
    }
    graph.set(file, bareImports)
  }
  return graph
}

describe('testing barrel stays importable under plain node', () => {
  it('no module statically reachable from the barrel imports vitest', () => {
    const graph = staticGraph(resolve(testingRoot, 'index.ts'))
    const offenders = [...graph.entries()]
      .filter(([, bare]) => bare.includes('vitest'))
      .map(([file]) => file.slice(file.indexOf('src/')))

    expect(offenders).toEqual([])
    // Sanity floor: the walk actually covered the barrel's closure, not a trivially empty graph.
    expect(graph.size).toBeGreaterThan(5)
  })

  it('the walk detects a vitest import when one is reachable (calibration)', () => {
    // matchers.ts legitimately imports vitest and is deliberately NOT in the barrel's static
    // graph — walking from it directly must flag it, proving the detector can fire.
    const graph = staticGraph(resolve(testingRoot, 'matchers.ts'))
    const offenders = [...graph.entries()].filter(([, bare]) => bare.includes('vitest'))
    expect(offenders.length).toBeGreaterThan(0)
  })
})
