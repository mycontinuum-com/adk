import { z } from 'zod'

function getDef(s: z.ZodType): Record<string, any> {
  return (s as any)._def ?? {}
}

function normalize(schema: z.ZodType): z.ZodType {
  const d = getDef(schema)
  const t = d.typeName

  if (t === 'ZodObject' && d.shape) {
    const shape = d.shape()
    const out: Record<string, z.ZodType> = {}
    let changed = false

    for (const [k, v] of Object.entries(shape)) {
      const f = v as z.ZodType
      const fd = getDef(f)

      if (fd.typeName === 'ZodOptional' && fd.innerType && !fd.innerType.isNullable()) {
        const inner = normalize(fd.innerType)
        const fixed = inner.nullable().optional()
        out[k] = fd.description ? fixed.describe(fd.description) : fixed
        changed = true
      } else {
        const n = normalize(f)
        out[k] = n
        if (n !== f) changed = true
      }
    }

    if (!changed) return schema
    let result: z.ZodType = z.object(out)
    if (d.unknownKeys === 'strict') result = (result as z.ZodObject<any>).strict()
    else if (d.unknownKeys === 'passthrough') result = (result as z.ZodObject<any>).passthrough()
    return d.description ? result.describe(d.description) : result
  }

  const inner = d.innerType ?? d.type
  if (inner) {
    const n = normalize(inner)
    if (n === inner) return schema
    let rebuilt: z.ZodType
    if (t === 'ZodArray') rebuilt = z.array(n)
    else if (t === 'ZodNullable') rebuilt = n.nullable()
    else if (t === 'ZodOptional') rebuilt = n.optional()
    else if (t === 'ZodDefault' && d.defaultValue) rebuilt = n.default(d.defaultValue())
    else return schema
    return d.description ? rebuilt.describe(d.description) : rebuilt
  }

  if (d.options && (t === 'ZodUnion' || t === 'ZodDiscriminatedUnion')) {
    let changed = false
    const opts = (d.options as z.ZodType[]).map((o) => {
      const n = normalize(o)
      if (n !== o) changed = true
      return n
    })
    if (!changed) return schema
    const rebuilt =
      t === 'ZodUnion'
        ? z.union(opts as [z.ZodType, z.ZodType, ...z.ZodType[]])
        : z.discriminatedUnion(d.discriminator, opts as any)
    return d.description ? rebuilt.describe(d.description) : rebuilt
  }

  if (t === 'ZodRecord' && d.valueType) {
    const n = normalize(d.valueType)
    if (n === d.valueType) return schema
    const rebuilt = z.record(d.keyType ?? z.string(), n)
    return d.description ? rebuilt.describe(d.description) : rebuilt
  }

  if (t === 'ZodLazy' && d.getter) {
    return z.lazy(() => normalize(d.getter()))
  }

  return schema
}

let hasWarned = false

export function normalizeSchema(schema: z.ZodType, name: string): z.ZodType {
  const result = normalize(schema)
  if (result !== schema && !hasWarned) {
    hasWarned = true
    console.warn(
      `[adk] Auto-patched Zod schema "${name}" for structured output compatibility: ` +
        `optional fields without .nullable() were wrapped automatically. ` +
        `To remove this warning, use .nullable().optional() instead of .optional().`,
    )
  }
  return result
}

export function resetNormalizeWarning(): void {
  hasWarned = false
}
