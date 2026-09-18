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
    return stripSchemaMarker(
      convertZod3(schema, {
        $refStrategy: 'none',
        target: 'openAi',
        override: (definition: object) => {
          const original = bridgedSchema(definition)
          return original ? convert(original) : ignoreOverride
        },
      }),
    )
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
