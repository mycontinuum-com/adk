import type { z } from 'zod'

import type {
  RenderContext,
  Agent,
  ModelStartEvent,
  ModelEndEvent,
  ModelUsage,
  ContextMessageSummary,
  ContextToolSummary,
  Event,
  FunctionTool,
  OutputMode,
} from '../types'
import type { Session } from '../types'

import { partitionTools, expandMCPTools, signalOutput, isOutputSignal } from '../core/tools'
import { createEventId } from '../session'
import { createStateAccessor } from './state'

function isObjectSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false
  const def = (schema as { _def?: { typeName?: string } })._def
  return def?.typeName === 'ZodObject'
}

interface OutputAnalysis {
  schema?: z.ZodType
  mode?: OutputMode
  outputTool?: FunctionTool
}

function analyzeOutput(agent: Agent): OutputAnalysis {
  const output = agent.output
  if (!output || typeof output === 'string') return {}
  if ('name' in output && 'description' in output) {
    return { outputTool: output as FunctionTool }
  }
  if ('schema' in output && isObjectSchema(output.schema)) {
    return { schema: output.schema, mode: output.mode ?? 'native' }
  }
  return {}
}

export function eventToMessageSummary(event: Event): ContextMessageSummary | null {
  switch (event.type) {
    case 'system':
      return { role: 'system', content: event.text }
    case 'user':
      return { role: 'user', content: event.text }
    case 'assistant':
      return { role: 'assistant', content: event.text }
    case 'thought':
      return { role: 'thought', content: event.text }
    case 'tool_call':
      return {
        role: 'tool_call',
        content: `${event.name} ${JSON.stringify(event.args)}`,
      }
    case 'tool_result':
      return {
        role: 'tool_result',
        content: event.error
          ? `${event.name} error: ${event.error}`
          : `${event.name} ${JSON.stringify(event.result)}`,
      }
    default:
      return null
  }
}

function toolToSummary(tool: FunctionTool): ContextToolSummary {
  return {
    name: tool.name,
    description: tool.description,
  }
}

function getOutputSchemaName(ctx: RenderContext): string | undefined {
  const output = ctx.agent.output
  if (!output) return undefined
  if (typeof output === 'string') return output
  if ('key' in output) return output.key
  return `${ctx.agent.name}.output`
}

export function createStartEvent(
  ctx: RenderContext,
  stepIndex: number,
  invocationId: string,
): ModelStartEvent {
  let messageCount = 0
  for (const event of ctx.events) {
    if (eventToMessageSummary(event)) messageCount++
  }

  return {
    id: createEventId(),
    type: 'model_start',
    createdAt: Date.now(),
    invocationId,
    agentName: ctx.agentName,
    stepIndex,
    messageCount,
    tools: ctx.functionTools.map(toolToSummary),
    outputSchema: ctx.outputSchema ? getOutputSchemaName(ctx) : undefined,
  }
}

export interface CreateEndEventOptions {
  invocationId: string
  agentName: string
  stepIndex: number
  durationMs: number
  usage?: ModelUsage
  finishReason?: ModelEndEvent['finishReason']
  error?: string
}

export function createEndEvent(options: CreateEndEventOptions): ModelEndEvent {
  return {
    id: createEventId(),
    type: 'model_end',
    createdAt: Date.now(),
    invocationId: options.invocationId,
    agentName: options.agentName,
    stepIndex: options.stepIndex,
    durationMs: options.durationMs,
    usage: options.usage,
    finishReason: options.finishReason,
    error: options.error,
  }
}

function withOutputTool(functionTools: FunctionTool[], outputTool?: FunctionTool): FunctionTool[] {
  if (!outputTool) return functionTools
  const wrapped = ensureOutputSignal(outputTool)
  const idx = functionTools.findIndex((t) => t.name === outputTool.name)
  if (idx >= 0) {
    const copy = [...functionTools]
    copy[idx] = wrapped
    return copy
  }
  return [...functionTools, wrapped]
}

/**
 * Wraps an output tool so its execute always produces an OutputSignal. If the user already calls
 * ctx.output(), the signal passes through unchanged. Otherwise, the tool's return value (or
 * ctx.args if undefined) is auto-wrapped.
 */
function ensureOutputSignal(tool: FunctionTool): FunctionTool {
  const originalExecute = tool.execute
  return {
    ...tool,
    execute: async (ctx: any) => {
      const result = originalExecute ? await originalExecute(ctx) : undefined
      if (isOutputSignal(result)) return result
      return signalOutput(result === undefined ? ctx.args : result)
    },
  }
}

export function createRenderContext(
  session: Session,
  agent: Agent,
  invocationId: string,
): RenderContext {
  const { schema, mode, outputTool } = analyzeOutput(agent)
  const { functionTools, providerTools } = partitionTools(agent.tools)
  return {
    invocationId,
    agentName: agent.name,
    session,
    state: createStateAccessor(session, invocationId),
    agent,
    events: [],
    functionTools: withOutputTool(functionTools as FunctionTool[], outputTool),
    providerTools,
    outputSchema: schema,
    outputMode: mode,
  }
}

export async function createRenderContextAsync(
  session: Session,
  agent: Agent,
  invocationId: string,
): Promise<RenderContext> {
  const { schema, mode, outputTool } = analyzeOutput(agent)
  const { functionTools, providerTools } = await expandMCPTools(agent.tools)
  return {
    invocationId,
    agentName: agent.name,
    session,
    state: createStateAccessor(session, invocationId),
    agent,
    events: [],
    functionTools: withOutputTool(functionTools as FunctionTool[], outputTool),
    providerTools,
    outputSchema: schema,
    outputMode: mode,
  }
}

export function buildContext(session: Session, agent: Agent, invocationId: string): RenderContext {
  const initial = createRenderContext(session, agent, invocationId)
  let ctx = initial
  for (const renderer of agent.context) {
    const result = renderer(ctx)
    if (result instanceof Promise) {
      throw new Error(
        'Async context renderer used with synchronous buildContext. Use buildContextAsync instead.',
      )
    }
    ctx = result
  }
  return ctx
}

export async function buildContextAsync(
  session: Session,
  agent: Agent,
  invocationId: string,
): Promise<RenderContext> {
  let ctx = await createRenderContextAsync(session, agent, invocationId)
  for (const renderer of agent.context) {
    const result = renderer(ctx)
    ctx = result instanceof Promise ? await result : result
  }
  return ctx
}
