import type { DistanceMatrixPair } from './types'

const DEFAULT_DENSITY_K = 10

function distanceFromScore(score: number): number {
  return 1 - score
}

function buildDistanceLookup(pairs: DistanceMatrixPair[]): Map<string, Map<string, number>> {
  const lookup = new Map<string, Map<string, number>>()
  for (const { a, b, score } of pairs) {
    const dist = distanceFromScore(score)
    const aStr = String(a)
    const bStr = String(b)
    if (!lookup.has(aStr)) lookup.set(aStr, new Map())
    lookup.get(aStr)!.set(bStr, dist)
    if (!lookup.has(bStr)) lookup.set(bStr, new Map())
    lookup.get(bStr)!.set(aStr, dist)
  }
  return lookup
}

function getPointIds(pairs: DistanceMatrixPair[]): Set<string> {
  const ids = new Set<string>()
  for (const { a, b } of pairs) {
    ids.add(String(a))
    ids.add(String(b))
  }
  return ids
}

function computeDensity(
  lookup: Map<string, Map<string, number>>,
  pointIds: Iterable<string>,
  k: number,
): Map<string, number> {
  const density = new Map<string, number>()
  for (const id of pointIds) {
    const neighbors = lookup.get(id)
    if (!neighbors || neighbors.size === 0) {
      density.set(id, 1)
      continue
    }
    const sorted = Array.from(neighbors.values()).toSorted((x, y) => x - y)
    const kNearest = sorted.slice(0, Math.min(k, sorted.length))
    const meanDist = kNearest.reduce((s, d) => s + d, 0) / kNearest.length || 1e-6
    density.set(id, 1 / meanDist)
  }
  return density
}

export function estimateDensity(
  pairs: DistanceMatrixPair[],
  k: number = DEFAULT_DENSITY_K,
): Map<string, number> {
  return computeDensity(buildDistanceLookup(pairs), getPointIds(pairs), k)
}

export interface RepresentativeSampleOptions {
  densityK?: number
  weights?: Map<string, number>
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Greedy farthest-point traversal directly on embedding vectors. Same diversity guarantee as
 * representativeSample but without requiring a pre-computed server-side distance matrix — O(n ×
 * pool × d) local computation instead of O(pool²) on the vector DB.
 *
 * Skips density estimation (which would be O(pool² × d)) since it has diminishing impact at large
 * pool sizes. Seed selection uses weight alone, or random if unweighted.
 */
export function representativeSampleFromVectors(
  vectors: Map<string, number[]>,
  n: number,
  options?: RepresentativeSampleOptions,
): string[] {
  const pointIds = Array.from(vectors.keys())
  if (n > pointIds.length) {
    throw new Error(`Cannot sample ${n} from pool of ${pointIds.length}`)
  }
  if (n <= 0) return []

  const vecs = pointIds.map((id) => vectors.get(id)!)

  function getWeight(idx: number): number {
    return options?.weights?.get(pointIds[idx]) ?? 1
  }

  const selected: string[] = []
  const minDist = new Float64Array(pointIds.length).fill(Infinity)
  const dead = new Uint8Array(pointIds.length)

  let firstIdx = 0
  if (options?.weights) {
    let bestW = -Infinity
    for (let i = 0; i < pointIds.length; i++) {
      const w = getWeight(i)
      if (w > bestW) {
        bestW = w
        firstIdx = i
      }
    }
  } else {
    firstIdx = Math.floor(Math.random() * pointIds.length)
  }

  selected.push(pointIds[firstIdx])
  dead[firstIdx] = 1
  minDist[firstIdx] = 0
  let lastSelectedIdx = firstIdx

  for (let s = 1; s < n; s++) {
    const lv = vecs[lastSelectedIdx]
    let bestScore = -Infinity
    let bestIdx = 0

    for (let i = 0; i < pointIds.length; i++) {
      if (dead[i]) continue
      const d = 1 - dot(lv, vecs[i])
      if (d < minDist[i]) minDist[i] = d
      const score = minDist[i] * getWeight(i)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    selected.push(pointIds[bestIdx])
    dead[bestIdx] = 1
    minDist[bestIdx] = 0
    lastSelectedIdx = bestIdx
  }

  return selected
}

export function representativeSample(
  pairs: DistanceMatrixPair[],
  n: number,
  options?: RepresentativeSampleOptions,
): string[] {
  const pointIds = Array.from(getPointIds(pairs))
  if (n > pointIds.length) {
    throw new Error(`Cannot sample ${n} from pool of ${pointIds.length}`)
  }
  if (n <= 0) return []

  const densityK = options?.densityK ?? DEFAULT_DENSITY_K
  const lookup = buildDistanceLookup(pairs)
  const density = computeDensity(lookup, pointIds, densityK)

  function getWeight(id: string): number {
    return options?.weights?.get(id) ?? 1
  }

  function dist(a: string, b: string): number {
    return lookup.get(a)?.get(b) ?? Infinity
  }

  const selected: string[] = []
  const selectedSet = new Set<string>()
  const minDist = new Map<string, number>()
  for (const id of pointIds) {
    minDist.set(id, Infinity)
  }

  let firstScore = -Infinity
  let firstId = pointIds[0]
  for (const id of pointIds) {
    const d = density.get(id) ?? 0
    const w = getWeight(id)
    const s = d * w
    if (s > firstScore) {
      firstScore = s
      firstId = id
    }
  }
  selected.push(firstId)
  selectedSet.add(firstId)
  minDist.set(firstId, 0)

  for (let s = 1; s < n; s++) {
    const lastId = selected[s - 1]
    for (const id of pointIds) {
      if (selectedSet.has(id)) continue
      const d = dist(id, lastId)
      const current = minDist.get(id) ?? Infinity
      minDist.set(id, Math.min(current, d))
    }

    let bestScore = -Infinity
    let bestId = pointIds[0]
    for (const id of pointIds) {
      if (selectedSet.has(id)) continue
      const d = density.get(id) ?? 0
      const m = minDist.get(id) ?? 0
      const w = getWeight(id)
      const score = d * m * w
      if (score > bestScore) {
        bestScore = score
        bestId = id
      }
    }
    selected.push(bestId)
    selectedSet.add(bestId)
    minDist.set(bestId, 0)
  }

  return selected
}
