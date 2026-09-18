import { z } from 'zod/v3'

type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'literal' | 'array' | 'unknown'

interface FieldDescriptor {
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

function getKind(schema: z.ZodTypeAny): FieldKind {
  const typeName = schema._def.typeName
  switch (typeName) {
    case 'ZodString':
      return 'string'
    case 'ZodNumber':
      return 'number'
    case 'ZodBoolean':
      return 'boolean'
    case 'ZodEnum':
    case 'ZodNativeEnum':
      return 'enum'
    case 'ZodLiteral':
      return 'literal'
    case 'ZodArray':
      return 'array'
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return getKind(schema._def.innerType)
    default:
      return 'unknown'
  }
}

function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny
  required: boolean
  defaultValue?: unknown
} {
  let current = schema
  let required = true
  let defaultValue: unknown

  while (true) {
    const typeName = current._def.typeName
    if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
      required = false
      current = current._def.innerType
    } else if (typeName === 'ZodDefault') {
      required = false
      defaultValue = current._def.defaultValue()
      current = current._def.innerType
    } else {
      break
    }
  }
  return { inner: current, required, defaultValue }
}

export function inspectSchema(schema: z.ZodTypeAny): SchemaDescriptor {
  const { inner } = unwrap(schema)

  if (inner._def.typeName === 'ZodObject') {
    const shape = inner._def.shape()
    const fields: FieldDescriptor[] = Object.entries(shape).map(([name, fieldSchema]) => {
      const s = fieldSchema as z.ZodTypeAny
      const { inner: fi, required, defaultValue } = unwrap(s)
      const kind = getKind(s)

      const field: FieldDescriptor = { name, kind, required, defaultValue }
      field.description = s._def.description ?? s.description

      if (kind === 'enum') {
        if (fi._def.typeName === 'ZodEnum') field.enumValues = fi._def.values
        if (fi._def.typeName === 'ZodNativeEnum') field.enumValues = Object.values(fi._def.values)
      }
      if (kind === 'literal') field.literalValue = fi._def.value

      if (kind === 'array' && fi._def.type) {
        const itemType = fi._def.type
        if (itemType._def?.typeName === 'ZodObject') {
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
    description: schema._def.description ?? schema.description,
  }

  if (kind === 'enum') {
    const { inner: fi } = unwrap(schema)
    if (fi._def.typeName === 'ZodEnum') field.enumValues = fi._def.values
    if (fi._def.typeName === 'ZodNativeEnum') field.enumValues = Object.values(fi._def.values)
  }
  if (kind === 'literal') {
    const { inner: fi } = unwrap(schema)
    field.literalValue = fi._def.value
  }

  return { fields: [field], isSimple: true }
}
