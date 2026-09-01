import { z } from 'zod'

import type { ToolYieldEvent } from '../types/events'
import type { Tool, FunctionTool, ProviderTool, MCPTool, Runnable } from '../types/runnables'

import { coerce } from '../parser/coercion/index'

export const CONTROL = Symbol.for('adk.control')

export interface YieldSignal {
  readonly [CONTROL]: 'yield'
  invocationId: string
  yieldedTools: ToolYieldEvent[]
  status?: 'yielded_tool' | 'yielded_message'
}

export interface OutputSignal {
  readonly [CONTROL]: 'output'
  value: unknown
}

export interface EndSignal {
  readonly [CONTROL]: 'end'
}

export type ControlSignal = YieldSignal | OutputSignal | EndSignal

export function isControlSignal(value: unknown): value is ControlSignal {
  return typeof value === 'object' && value !== null && CONTROL in value
}

export function isYieldSignal(value: unknown): value is YieldSignal {
  return isControlSignal(value) && value[CONTROL] === 'yield'
}

export function isOutputSignal(value: unknown): value is OutputSignal {
  return isControlSignal(value) && value[CONTROL] === 'output'
}

export function isEndSignal(value: unknown): value is EndSignal {
  return isControlSignal(value) && value[CONTROL] === 'end'
}

export function signalOutput(value: unknown): OutputSignal {
  return { [CONTROL]: 'output', value }
}

export function signalEnd(): EndSignal {
  return { [CONTROL]: 'end' }
}

export function isRunnable(value: unknown): value is Runnable<any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as Runnable).kind === 'string' &&
    ['agent', 'step', 'sequence', 'parallel', 'loop'].includes((value as Runnable).kind)
  )
}

export function signalYield(info: Omit<YieldSignal, typeof CONTROL>): YieldSignal {
  return { [CONTROL]: 'yield', ...info }
}

export function isMCPTool(tool: Tool): tool is MCPTool {
  return 'kind' in tool && (tool as MCPTool).kind === 'mcp_server'
}

export function isProviderTool(tool: Tool): tool is ProviderTool {
  return 'type' in tool && typeof (tool as ProviderTool).type === 'string'
}

export function isFunctionTool(tool: Tool): tool is FunctionTool {
  return !isProviderTool(tool) && !isMCPTool(tool)
}

export interface PartitionedTools {
  functionTools: FunctionTool[]
  providerTools: ProviderTool[]
  mcpTools: MCPTool[]
}

export function partitionTools(tools: Tool[]): PartitionedTools {
  const functionTools: FunctionTool[] = []
  const providerTools: ProviderTool[] = []
  const mcpTools: MCPTool[] = []
  for (const t of tools) {
    if (isMCPTool(t)) {
      mcpTools.push(t)
    } else if (isProviderTool(t)) {
      providerTools.push(t)
    } else {
      functionTools.push(t)
    }
  }
  return { functionTools, providerTools, mcpTools }
}

export async function expandMCPTools(tools: Tool[]): Promise<{
  functionTools: FunctionTool[]
  providerTools: ProviderTool[]
}> {
  const { functionTools, providerTools, mcpTools } = partitionTools(tools)

  const mcpToolArrays = await Promise.all(mcpTools.map((mcp) => mcp.tools()))

  const allFunctionTools = [...functionTools, ...mcpToolArrays.flat()]

  return { functionTools: allFunctionTools, providerTools }
}

export function safeParseToolArgs<T>(
  args: unknown,
  schema: z.ZodType<T>,
): z.SafeParseReturnType<unknown, T> {
  const coerced = coerce(args, schema)
  return schema.safeParse(coerced.success ? coerced.value : args)
}
