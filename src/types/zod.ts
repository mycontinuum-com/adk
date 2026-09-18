import type * as z3 from 'zod/v3'
import type * as z4 from 'zod/v4'

/** The common public surface implemented by both supported Zod Classic generations. */
export interface ZodSchema<Output = unknown, Input = unknown> {
  readonly _output: Output
  readonly _input: Input
  parse(value: unknown): Output
  safeParse(value: unknown): SafeParseResult<Output>
}

export type AnyZodSchema = ZodSchema<any, any>

export type ZodOutput<S extends AnyZodSchema> = S['_output']

export type SafeParseResult<T> =
  | { success: true; data: T }
  | {
      success: false
      error: {
        message: string
        issues: readonly { path: readonly PropertyKey[]; message: string }[]
      }
    }

export function isZod4Schema(schema: unknown): schema is z4.ZodType {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '_zod' in schema &&
    typeof (schema as { optional?: unknown }).optional === 'function' &&
    typeof (schema as { nullable?: unknown }).nullable === 'function'
  )
}

export function isZod3Schema(schema: unknown): schema is z3.ZodTypeAny {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    !('_zod' in schema) &&
    '_def' in schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  )
}

export function isSupportedZodSchema(schema: unknown): schema is AnyZodSchema {
  return isZod3Schema(schema) || isZod4Schema(schema)
}

type ZodDefinition = {
  type?: string
  typeName?: string
  innerType?: AnyZodSchema
  schema?: AnyZodSchema
}

function schemaDefinition(schema: AnyZodSchema): ZodDefinition {
  if (isZod4Schema(schema)) return schema._zod.def as ZodDefinition
  if (isZod3Schema(schema)) return schema._def as ZodDefinition
  throw new Error('Unsupported schema')
}

export function schemaKind(schema: AnyZodSchema): string | undefined {
  const definition = schemaDefinition(schema)
  if (definition.type) return definition.type
  return definition.typeName?.replace(/^Zod/, '').toLowerCase()
}

function unwrapSchema(schema: AnyZodSchema): AnyZodSchema {
  let current = schema
  while (true) {
    const definition = schemaDefinition(current)
    const kind = schemaKind(current)
    if (
      kind !== 'optional' &&
      kind !== 'nullable' &&
      kind !== 'default' &&
      kind !== 'readonly' &&
      kind !== 'catch' &&
      kind !== 'branded'
    ) {
      return current
    }
    const inner = definition.innerType ?? definition.schema
    if (!inner) return current
    current = inner
  }
}

const PRIMITIVE_KINDS = new Set([
  'string',
  'number',
  'boolean',
  'enum',
  'nativeenum',
  'literal',
  'null',
  'undefined',
  'bigint',
  'date',
])

export function isPrimitiveSchema(schema: AnyZodSchema | undefined): boolean {
  return schema ? PRIMITIVE_KINDS.has(schemaKind(unwrapSchema(schema)) ?? '') : false
}

const SCHEMA_BRIDGE = Symbol.for('@animahealth/adk/zod-schema-bridge')

/** Records the original schema behind a same-generation wrapper used for mixed Zod composition. */
export function registerSchemaBridge(bridge: AnyZodSchema, original: AnyZodSchema): void {
  Object.defineProperty(bridge, SCHEMA_BRIDGE, { value: original })
  Object.defineProperty(schemaDefinition(bridge), SCHEMA_BRIDGE, { value: original })
}

export function bridgedSchema(value: object): AnyZodSchema | undefined {
  return (value as { [SCHEMA_BRIDGE]?: AnyZodSchema })[SCHEMA_BRIDGE]
}
