import type {
  VectorFilter,
  VectorCondition,
  HasIdCondition,
  FilterInput,
  Match,
  DistanceMatrixPair,
} from './types'

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export function normalizeFilter(input: FilterInput | undefined): VectorFilter | undefined {
  if (input == null) return undefined
  const obj = input as Record<string, unknown>
  if (
    ('must' in obj && Array.isArray(obj.must)) ||
    ('should' in obj && Array.isArray(obj.should)) ||
    ('must_not' in obj && Array.isArray(obj.must_not))
  ) {
    return input as VectorFilter
  }
  const conditions: VectorCondition[] = []
  for (const [key, value] of Object.entries(input)) {
    conditions.push({ key, match: { value } })
  }
  return conditions.length > 0 ? { must: conditions } : undefined
}

export function evaluateCondition(cond: VectorCondition, meta: Record<string, unknown>): boolean {
  const value = meta[cond.key]
  if (cond.match) return value === cond.match.value
  if (cond.text) {
    if (typeof value !== 'string') return false
    const lower = value.toLowerCase()
    return [cond.text.contains].flat().some((t) => lower.includes(t.toLowerCase()))
  }
  if (cond.range) {
    const firstBound = cond.range.gt ?? cond.range.gte ?? cond.range.lt ?? cond.range.lte
    if (typeof firstBound === 'string') {
      const str = String(value ?? '')
      if (cond.range.gt != null && !(str > cond.range.gt)) return false
      if (cond.range.gte != null && !(str >= cond.range.gte)) return false
      if (cond.range.lt != null && !(str < cond.range.lt)) return false
      if (cond.range.lte != null && !(str <= cond.range.lte)) return false
      return true
    }
    const num = Number(value)
    if (isNaN(num)) return false
    if (cond.range.gt != null && !(num > Number(cond.range.gt))) return false
    if (cond.range.gte != null && !(num >= Number(cond.range.gte))) return false
    if (cond.range.lt != null && !(num < Number(cond.range.lt))) return false
    if (cond.range.lte != null && !(num <= Number(cond.range.lte))) return false
    return true
  }
  return true
}

function evaluateEntry(
  entry: VectorCondition | HasIdCondition | VectorFilter,
  id: string,
  meta: Record<string, unknown>,
): boolean {
  if ('has_id' in entry) return (entry as HasIdCondition).has_id.includes(id)
  if ('key' in entry) return evaluateCondition(entry as VectorCondition, meta)
  return matchesFilter(entry as VectorFilter, id, meta)
}

export function matchesFilter(
  filter: VectorFilter | undefined,
  id: string,
  meta: Record<string, unknown>,
): boolean {
  if (!filter) return true
  if (filter.must && !filter.must.every((e) => evaluateEntry(e, id, meta))) {
    return false
  }
  if (
    filter.should &&
    filter.should.length > 0 &&
    !filter.should.some((e) => evaluateEntry(e, id, meta))
  ) {
    return false
  }
  if (filter.must_not && filter.must_not.some((e) => evaluateEntry(e, id, meta))) {
    return false
  }
  return true
}

export function mergeMetadata(
  existing: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing }
  for (const [key, value] of Object.entries(update)) {
    if (value === null) delete merged[key]
    else if (value !== undefined) merged[key] = value
  }
  return merged
}

export function prunePairs(pairs: DistanceMatrixPair[], limit: number): DistanceMatrixPair[] {
  const perPoint = new Map<string, DistanceMatrixPair[]>()
  for (const p of pairs) {
    if (!perPoint.has(p.a)) perPoint.set(p.a, [])
    perPoint.get(p.a)!.push(p)
    if (!perPoint.has(p.b)) perPoint.set(p.b, [])
    perPoint.get(p.b)!.push(p)
  }
  const kept = new Set<DistanceMatrixPair>()
  for (const [, pointPairs] of perPoint) {
    pointPairs.sort((x, y) => y.score - x.score)
    for (let i = 0; i < Math.min(limit, pointPairs.length); i++) {
      kept.add(pointPairs[i])
    }
  }
  return pairs.filter((p) => kept.has(p))
}

export function renderMatches(matches: Match[]): string {
  return matches
    .map((m) => {
      const tag = m.kind ?? 'memory'
      return `[${tag}] (id="${m.id}")\n${m.content}`
    })
    .join('\n\n---\n\n')
}
