import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

/**
 * Convert a Zod schema to a JSON Schema tool definition.
 *
 * Produces flat JSON Schema output (no $ref / definitions wrapping) compatible with OpenAI, Gemini,
 * and Claude tool/function calling APIs.
 */
export function zodToToolSchema(
  name: string,
  description: string,
  schema: z.ZodType,
): { name: string; description: string; parameters: Record<string, unknown> } {
  const parameters = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'openAi',
  }) as Record<string, unknown>

  delete parameters.$schema

  return { name, description, parameters }
}
