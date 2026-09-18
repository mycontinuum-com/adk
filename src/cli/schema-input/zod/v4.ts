import { z } from 'zod/v4'

type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'literal' | 'array' | 'unknown'

export interface FieldDescriptor {
  name: string
  kind: FieldKind
  required: boolean
  description?: string
  defaultValue?: unknown
  enumValues?: string[]
  literalValue?: unknown
  arrayItemFields?: FieldDescriptor[]
}

export interface SchemaDescriptor {
  fields: FieldDescriptor[]
  isSimple: boolean
}

function getKind(schema: z.ZodType): FieldKind {
  const { inner } = unwrap(schema)
  switch (inner.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
    case 'literal':
    case 'array':
      return inner.type
    default:
      return 'unknown'
  }
}

function unwrap(schema: z.ZodType): {
  inner: z.ZodType
  required: boolean
  defaultValue?: unknown
} {
  let current = schema
  let required = true
  let defaultValue: unknown
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    required = false
    if (current instanceof z.ZodDefault) defaultValue = current.def.defaultValue
    const inner = current.unwrap()
    if (!(inner instanceof z.ZodType)) throw new Error('CLI schemas must use Zod Classic')
    current = inner
  }
  return { inner: current, required, defaultValue }
}

export function inspectSchema(schema: z.ZodTypeAny): SchemaDescriptor {
  const { inner } = unwrap(schema)

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape
    const fields: FieldDescriptor[] = Object.entries(shape).map(([name, fieldSchema]) => {
      const s = fieldSchema as z.ZodTypeAny
      const { inner: fi, required, defaultValue } = unwrap(s)
      const kind = getKind(s)

      const field: FieldDescriptor = { name, kind, required, defaultValue }
      field.description = s.description

      if (kind === 'enum') {
        if (fi instanceof z.ZodEnum) field.enumValues = fi.options.map(String)
      }
      if (fi instanceof z.ZodLiteral) field.literalValue = fi.value

      if (fi instanceof z.ZodArray) {
        const itemType = fi.element
        if (itemType instanceof z.ZodObject) {
          const itemDescriptor = inspectSchema(itemType)
          field.arrayItemFields = itemDescriptor.fields
        }
      }

      return field
    })

    const SIMPLE_KINDS = new Set(['string', 'number', 'boolean', 'enum', 'literal'])
    const isSimple =
      fields.length <= 5 &&
      fields.every((f) => {
        if (f.kind === 'array' && f.arrayItemFields) {
          return (
            f.arrayItemFields.length <= 5 &&
            f.arrayItemFields.every((sf) => SIMPLE_KINDS.has(sf.kind))
          )
        }
        return SIMPLE_KINDS.has(f.kind)
      })

    return { fields, isSimple }
  }

  const kind = getKind(schema)
  const { required, defaultValue } = unwrap(schema)
  const field: FieldDescriptor = {
    name: 'value',
    kind,
    required,
    defaultValue,
    description: schema.description,
  }

  if (kind === 'enum') {
    const { inner: fi } = unwrap(schema)
    if (fi instanceof z.ZodEnum) field.enumValues = fi.options.map(String)
  }
  if (kind === 'literal') {
    const { inner: fi } = unwrap(schema)
    if (fi instanceof z.ZodLiteral) field.literalValue = fi.value
  }

  return { fields: [field], isSimple: true }
}

export function getDefaultValue(field: FieldDescriptor): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue
  switch (field.kind) {
    case 'string':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'enum':
      return field.enumValues?.[0] ?? ''
    case 'literal':
      return field.literalValue
    case 'array':
      if (field.arrayItemFields) {
        return [Object.fromEntries(field.arrayItemFields.map((f) => [f.name, getDefaultValue(f)]))]
      }
      return []
    default:
      return undefined
  }
}

export function estimateFormHeight(descriptor: SchemaDescriptor): number {
  let lines = 2
  for (const field of descriptor.fields) {
    if (field.kind === 'array' && field.arrayItemFields) {
      lines += 1
      lines += 2 + field.arrayItemFields.length
      lines += 1
      lines += 1
    } else {
      lines += 1
    }
  }
  return lines
}
