import { z } from 'zod'

import type { FunctionTool } from '../types'
import type { StateSchema } from '../types/schema'
import type { MCPToolInfo, MCPClientInterface } from './types'

export function createMCPTool<S extends StateSchema>(
  serverName: string,
  tool: MCPToolInfo,
  client: MCPClientInterface,
): FunctionTool<Record<string, unknown>, unknown, unknown, S> {
  const mcpToolName = tool.name
  return {
    name: `mcp_${serverName}_${mcpToolName}`,
    description: tool.description || `MCP tool: ${mcpToolName}`,
    schema: jsonSchemaToZod(tool.inputSchema),
    async execute(ctx) {
      let result
      try {
        result = await client.callTool(mcpToolName, ctx.args)
      } catch (e) {
        throw new Error(
          `MCP tool "${mcpToolName}" failed: ${e instanceof Error ? e.message : String(e)}`,
          {
            cause: e,
          },
        )
      }
      if (result.isError) {
        const text = result.content
          .filter(
            (c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text',
          )
          .map((c) => c.text)
          .join('\n')
        throw new Error(text || 'MCP tool failed')
      }
      if (result.content.length === 0) {
        return { success: true, message: 'Operation completed with no output' }
      }
      if (result.content.length === 1) {
        const block = result.content[0] as { type?: string; text?: string }
        if (block.type === 'text') {
          try {
            return JSON.parse(block.text!)
          } catch {
            return block.text
          }
        }
        return block
      }
      return result.content
    },
  }
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  if (schema.type !== 'object') return z.record(z.unknown())

  const props = (schema.properties || {}) as Record<string, Record<string, unknown>>
  const required = new Set((schema.required || []) as string[])
  const shape: Record<string, z.ZodType> = {}

  for (const [key, prop] of Object.entries(props)) {
    let field = propToZod(prop)
    if (prop.description) field = field.describe(prop.description as string)
    shape[key] = required.has(key) ? field : field.nullable().optional()
  }

  return z.object(shape).strict() as z.ZodType<Record<string, unknown>>
}

function propToZod(prop: Record<string, unknown>): z.ZodType {
  if (prop.const !== undefined) return z.literal(prop.const as string | number | boolean)

  const type = prop.type as string | string[]
  const nullable = Array.isArray(type) ? type.includes('null') : prop.nullable === true
  const baseType = Array.isArray(type) ? type.find((t) => t !== 'null') : type

  let schema: z.ZodType

  if (baseType === 'string') {
    if (prop.enum) {
      schema = z.enum(prop.enum as [string, ...string[]])
    } else {
      let str = z.string()
      if (typeof prop.minLength === 'number') str = str.min(prop.minLength)
      if (typeof prop.maxLength === 'number') str = str.max(prop.maxLength)
      if (typeof prop.pattern === 'string') str = str.regex(new RegExp(prop.pattern))
      schema = str
    }
  } else if (baseType === 'number' || baseType === 'integer') {
    let num = z.number()
    if (baseType === 'integer') num = num.int()
    if (typeof prop.minimum === 'number') num = num.min(prop.minimum)
    if (typeof prop.maximum === 'number') num = num.max(prop.maximum)
    if (typeof prop.exclusiveMinimum === 'number') num = num.gt(prop.exclusiveMinimum)
    if (typeof prop.exclusiveMaximum === 'number') num = num.lt(prop.exclusiveMaximum)
    schema = num
  } else if (baseType === 'boolean') {
    schema = z.boolean()
  } else if (baseType === 'array') {
    let arr = z.array(prop.items ? propToZod(prop.items as Record<string, unknown>) : z.unknown())
    if (typeof prop.minItems === 'number') arr = arr.min(prop.minItems)
    if (typeof prop.maxItems === 'number') arr = arr.max(prop.maxItems)
    schema = arr
  } else if (baseType === 'object') {
    schema = jsonSchemaToZod(prop)
  } else {
    schema = z.unknown()
  }

  return nullable ? schema.nullable() : schema
}
