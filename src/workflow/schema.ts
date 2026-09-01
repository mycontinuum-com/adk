/**
 * Static JSON-Schema → Zod converter for the CC-compat loader.
 *
 * CC `agent({ schema })` passes a JSON-Schema object literal. The loader converts it to an ADK
 * `output` Zod schema STATICALLY (the schema is a pure literal; no body execution). Fidelity rules
 * the loader MUST honor (see scenarios `cc-compat-schema-fidelity`):
 *
 * - `required` is preserved EXACTLY as the source array — a STRICT SUBSET of `properties`. Properties
 *   NOT listed in `required` become `.optional()`. The converter MUST NOT widen `required` to all
 *   keys (which would reject legitimate output omitting an optional key) nor narrow it to empty.
 * - `enum` membership is enforced.
 * - `additionalProperties: false` rejects extra keys (Zod `.strict()`).
 * - Nested array-of-object `required` is enforced recursively.
 * - Primitive `boolean`/`string`/`number` and `array` element types are enforced — never widened to
 *   `z.any()`.
 *
 * @module
 */

import { z } from 'zod'

/** A minimal JSON-Schema node shape (the subset the real attractors use). */
interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  enum?: unknown[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  additionalProperties?: boolean
}

/**
 * Convert a JSON-Schema object literal to a Zod schema, preserving structure and optionality.
 *
 * @param schema - The JSON-Schema literal from a CC `agent({ schema })` call.
 * @returns An equivalent Zod schema enforcing the same constraints.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  return convertNode(schema as JsonSchemaNode)
}

function convertNode(node: JsonSchemaNode): z.ZodTypeAny {
  // Enums are enforced regardless of declared `type` (string enums are the attractor shape).
  if (Array.isArray(node.enum)) {
    const values = node.enum
    if (values.length > 0 && values.every((v) => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]])
    }
    // Mixed/non-string enum: a union of literals (still enforced, not widened to any).
    const literals = values.map((v) => z.literal(v as never))
    if (literals.length === 1) return literals[0]
    return z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }

  switch (node.type) {
    case 'object':
      return convertObject(node)
    case 'array':
      return convertArray(node)
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    default:
      // No type and no enum — preserve as unknown rather than fabricating a constraint.
      return z.unknown()
  }
}

function convertObject(node: JsonSchemaNode): z.ZodTypeAny {
  const properties = node.properties ?? {}
  // The required set is taken EXACTLY from the source array — a strict subset of properties.
  const required = new Set(node.required ?? [])
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, propSchema] of Object.entries(properties)) {
    const converted = convertNode(propSchema)
    // A property listed in `required` stays required; everything else is optional.
    shape[key] = required.has(key) ? converted : converted.optional()
  }

  const base = z.object(shape)
  // additionalProperties:false → reject extra keys. Default (omitted/true) → allow passthrough off
  // by default in Zod (strip), which neither rejects nor enforces — we keep Zod's default (strip).
  return node.additionalProperties === false ? base.strict() : base
}

function convertArray(node: JsonSchemaNode): z.ZodTypeAny {
  // The element type is enforced (never widened to any) so array-of-number ≠ array-of-string.
  const itemSchema = node.items ? convertNode(node.items) : z.unknown()
  return z.array(itemSchema)
}
