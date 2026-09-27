import { z } from 'zod/v3'

function getDef(s: z.ZodType): Record<string, any> {
  return (s as any)._def ?? {}
}

function describedLike(d: Record<string, any>, rebuilt: z.ZodType): z.ZodType {
  return d.description ? rebuilt.describe(d.description) : rebuilt
}

function normalizeObject(schema: z.ZodType, d: Record<string, any>): z.ZodType {
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
  return describedLike(d, result)
}

function normalizeWrapper(
  schema: z.ZodType,
  d: Record<string, any>,
  t: unknown,
  inner: z.ZodType,
): z.ZodType {
  const n = normalize(inner)
  if (n === inner) return schema
  let rebuilt: z.ZodType
  if (t === 'ZodArray') rebuilt = z.array(n)
  else if (t === 'ZodNullable') rebuilt = n.nullable()
  else if (t === 'ZodOptional') rebuilt = n.optional()
  else if (t === 'ZodDefault' && d.defaultValue) rebuilt = n.default(d.defaultValue())
  else return schema
  return describedLike(d, rebuilt)
}

function normalizeUnion(schema: z.ZodType, d: Record<string, any>, t: unknown): z.ZodType {
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
  return describedLike(d, rebuilt)
}

function normalize(schema: z.ZodType): z.ZodType {
  const d = getDef(schema)
  const t = d.typeName

  if (t === 'ZodObject' && d.shape) {
    return normalizeObject(schema, d)
  }

  const inner = d.innerType ?? d.type
  if (inner) {
    return normalizeWrapper(schema, d, t, inner)
  }

  if (d.options && (t === 'ZodUnion' || t === 'ZodDiscriminatedUnion')) {
    return normalizeUnion(schema, d, t)
  }

  if (t === 'ZodRecord' && d.valueType) {
    const n = normalize(d.valueType)
    if (n === d.valueType) return schema
    const rebuilt = z.record(d.keyType ?? z.string(), n)
    return describedLike(d, rebuilt)
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
