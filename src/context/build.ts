import type {
  RenderContext,
  Session,
  Agent,
  ModelStartEvent,
  ModelEndEvent,
  ModelUsage,
  ContextMessageSummary,
  ContextToolSummary,
  Event,
  FunctionTool,
  OutputMode,
} from '../types';
import type { z } from 'zod';
import { createEventId } from '../session';
import { zodResponsesFunction } from 'openai/helpers/zod';
import { createBoundStateAccessor } from './state';
import { partitionTools } from '../core/tools';

function isObjectSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const def = (schema as { _def?: { typeName?: string } })._def;
  return def?.typeName === 'ZodObject';
}

interface OutputSchemaResult {
  schema?: z.ZodType;
  mode?: OutputMode;
}

function getOutputSchemaConfig(agent: Agent): OutputSchemaResult {
  const output = agent.output;
  if (!output || typeof output === 'string') return {};
  if ('schema' in output && isObjectSchema(output.schema)) {
    return {
      schema: output.schema,
      mode: output.mode ?? 'native',
    };
  }
  return {};
}

function eventToMessageSummary(event: Event): ContextMessageSummary | null {
  switch (event.type) {
    case 'system':
      return { role: 'system', content: event.text };
    case 'user':
      return { role: 'user', content: event.text };
    case 'assistant':
      return { role: 'assistant', content: event.text };
    case 'thought':
      return { role: 'thought', content: event.text };
    case 'tool_call':
      return {
        role: 'tool_call',
        content: `${event.name} ${JSON.stringify(event.args)}`,
      };
    case 'tool_result':
      return {
        role: 'tool_result',
        content: event.error
          ? `${event.name} error: ${event.error}`
          : `${event.name} ${JSON.stringify(event.result)}`,
      };
    default:
      return null;
  }
}

function toolToSummary(tool: FunctionTool): ContextToolSummary {
  return {
    name: tool.name,
    description: tool.description,
  };
}

function getOutputSchemaName(ctx: RenderContext): string | undefined {
  const output = ctx.agent.output;
  if (!output) return undefined;
  if (typeof output === 'string') return output;
  if ('key' in output) return output.key;
  return `${ctx.agent.name}.output`;
}

function serializeOutputSchema(
  ctx: RenderContext,
): Record<string, unknown> | undefined {
  if (!ctx.outputSchema) return undefined;
  const fn = zodResponsesFunction({
    name: 'output',
    description: 'Output schema',
    parameters: ctx.outputSchema,
  });
  return fn.parameters as Record<string, unknown>;
}

export function createStartEvent(
  ctx: RenderContext,
  stepIndex: number,
  invocationId: string,
): ModelStartEvent {
  const messages: ContextMessageSummary[] = [];
  for (const event of ctx.events) {
    const summary = eventToMessageSummary(event);
    if (summary) {
      messages.push(summary);
    }
  }

  return {
    id: createEventId(),
    type: 'model_start',
    createdAt: Date.now(),
    invocationId,
    agentName: ctx.agentName,
    stepIndex,
    messages,
    tools: ctx.functionTools.map(toolToSummary),
    outputSchema: ctx.outputSchema ? getOutputSchemaName(ctx) : undefined,
    serializedSchema: serializeOutputSchema(ctx),
  };
}

export interface CreateEndEventOptions {
  invocationId: string;
  agentName: string;
  stepIndex: number;
  durationMs: number;
  usage?: ModelUsage;
  finishReason?: ModelEndEvent['finishReason'];
  error?: string;
  modelName?: string;
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
    modelName: options.modelName,
  };
}

export function createRenderContext(
  session: Session,
  agent: Agent,
  invocationId: string,
): RenderContext {
  const outputConfig = getOutputSchemaConfig(agent);
  const { functionTools, providerTools } = partitionTools(agent.tools);
  return {
    invocationId,
    agentName: agent.name,
    session,
    state: createBoundStateAccessor(session, invocationId),
    agent,
    events: [],
    functionTools,
    providerTools,
    outputSchema: outputConfig.schema,
    outputMode: outputConfig.mode,
  };
}

export function buildContext(
  session: Session,
  agent: Agent,
  invocationId: string,
): RenderContext {
  const initial = createRenderContext(session, agent, invocationId);
  return agent.context.reduce((c, renderer) => renderer(c), initial);
}
