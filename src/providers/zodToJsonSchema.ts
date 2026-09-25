import type { ZodTypeAny as Zod3Type } from 'zod/v3'

import { ignoreOverride, zodToJsonSchema } from 'zod-to-json-schema'
import { z as z4 } from 'zod/v4'

import type { AnyZodSchema } from '../types/zod'

import { bridgedSchema, isZod3Schema, isZod4Schema } from '../types/zod'

const convertZod3 = zodToJsonSchema as unknown as (
  schema: Zod3Type,
  options: Record<string, unknown>,
) => Record<string, unknown>

function stripSchemaMarker(schema: Record<string, unknown>): Record<string, unknown> {
  delete schema.$schema
  return schema
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The parts of a Zod 3 definition read here, each checked rather than assumed. */
interface Zod3Def {
  readonly typeName?: string
  readonly description?: string
  /** The schema a wrapper such as `.optional()` wraps. */
  readonly inner?: Zod3Type
  /** An array's element schema. */
  readonly element?: Zod3Type
  /** An object's property schemas. */
  readonly shape?: Record<string, unknown>
}

const ZOD3_WRAPPERS = new Set([
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodCatch',
  'ZodReadonly',
  'ZodBranded',
  'ZodEffects',
])

function zod3Child(value: unknown): Zod3Type | undefined {
  return isZod3Schema(value) ? value : undefined
}

function zod3Def(schema: Zod3Type): Zod3Def {
  const def: unknown = schema._def
  if (!isRecord(def)) return {}
  const typeName = typeof def.typeName === 'string' ? def.typeName : undefined
  const shape: unknown =
    typeof def.shape === 'function' ? Reflect.apply(def.shape, def, []) : undefined
  return {
    typeName,
    description: typeof def.description === 'string' ? def.description : undefined,
    inner: zod3Child(def.innerType) ?? zod3Child(typeName === 'ZodBranded' ? def.type : def.schema),
    element: typeName === 'ZodArray' ? zod3Child(def.type) : undefined,
    shape: isRecord(shape) ? shape : undefined,
  }
}

function zod3Description(schema: Zod3Type): string | undefined {
  let found: string | undefined
  for (let current: Zod3Type | undefined = schema; current;) {
    const def = zod3Def(current)
    found = def.description ?? found
    if (!ZOD3_WRAPPERS.has(def.typeName ?? '')) break
    current = def.inner
  }
  return found
}

function zod3Object(schema: Zod3Type): Zod3Def | undefined {
  for (let current: Zod3Type | undefined = schema; current;) {
    const def = zod3Def(current)
    if (def.typeName === 'ZodObject' || def.typeName === 'ZodArray') return def
    if (!ZOD3_WRAPPERS.has(def.typeName ?? '')) return undefined
    current = def.inner
  }
  return undefined
}

/** The JSON schema's `properties` or `items`, or those of its first `anyOf` branch with them. */
function jsonBranch(
  json: Record<string, unknown>,
  key: 'properties' | 'items',
): Record<string, unknown> | undefined {
  const own = json[key]
  if (isRecord(own)) return own
  if (!Array.isArray(json.anyOf)) return undefined
  for (const option of json.anyOf) {
    const branch = isRecord(option) ? option[key] : undefined
    if (isRecord(branch)) return branch
  }
  return undefined
}

// zod-to-json-schema's openAi target drops a description written on a wrapper, such as
// `.optional().describe(...)`, so the model never receives it.
function restoreZod3Descriptions(schema: Zod3Type, json: Record<string, unknown>): void {
  const def = zod3Object(schema)
  if (def?.element) {
    const items = jsonBranch(json, 'items')
    if (items) restoreZod3Descriptions(def.element, items)
    return
  }
  const properties = def?.shape ? jsonBranch(json, 'properties') : undefined
  if (!def?.shape || !properties) return
  for (const [key, child] of Object.entries(def.shape)) {
    const property = properties[key]
    if (!isZod3Schema(child) || !isRecord(property)) continue
    const description = zod3Description(child)
    if (description !== undefined) property.description = description
    restoreZod3Descriptions(child, property)
  }
}

function convert(schema: AnyZodSchema): Record<string, unknown> {
  if (isZod4Schema(schema)) {
    return stripSchemaMarker(
      z4.toJSONSchema(schema, {
        target: 'draft-7',
        io: 'input',
        cycles: 'throw',
        reused: 'inline',
        unrepresentable: ({ zodSchema }) => (zodSchema instanceof z4.ZodCatch ? {} : 'throw'),
        override: ({ zodSchema, jsonSchema }) => {
          const original = bridgedSchema(zodSchema)
          if (original) {
            Object.assign(jsonSchema, convert(original))
            return
          }
          if (zodSchema instanceof z4.ZodDiscriminatedUnion && jsonSchema.oneOf) {
            jsonSchema.anyOf = jsonSchema.oneOf
            delete jsonSchema.oneOf
          }
          if (jsonSchema.type !== 'object' || !jsonSchema.properties) return
          const required = new Set(jsonSchema.required ?? [])
          for (const [key, property] of Object.entries(jsonSchema.properties)) {
            if (!required.has(key)) {
              jsonSchema.properties[key] = {
                anyOf: [
                  property === true ? {} : property === false ? { not: {} } : property,
                  { type: 'null' },
                ],
              }
            }
          }
          jsonSchema.required = Object.keys(jsonSchema.properties)
          if (zodSchema instanceof z4.ZodObject && !zodSchema.def.catchall) {
            jsonSchema.additionalProperties = false
          }
        },
      }) as Record<string, unknown>,
    )
  }

  if (isZod3Schema(schema)) {
    const json = stripSchemaMarker(
      convertZod3(schema, {
        $refStrategy: 'none',
        target: 'openAi',
        override: (definition: object) => {
          const original = bridgedSchema(definition)
          return original ? convert(original) : ignoreOverride
        },
      }),
    )
    restoreZod3Descriptions(schema, json)
    return json
  }

  throw new Error('Unsupported schema')
}

export function zodToToolSchema(
  name: string,
  description: string,
  schema: AnyZodSchema,
): { name: string; description: string; parameters: Record<string, unknown> } {
  return { name, description, parameters: convert(schema) }
}
