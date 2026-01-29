import OpenAI, { AzureOpenAI } from 'openai';
import { z } from 'zod';
import { zodResponsesFunction, zodTextFormat } from 'openai/helpers/zod';
import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses';
import type {
  ModelStepResult,
  ModelAdapter,
  ModelConfig,
  Event,
  RenderContext,
  Tool,
  StreamEvent,
  ToolCallEvent,
  ModelUsage,
  ModelEndEvent,
  ToolChoice,
} from '../types';
import { createEventId, createCallId } from '../session';
import { withStreamRetry } from '../core';
import {
  createStreamAccumulator,
  type RawDeltaEvent,
  type AccumulatedText,
} from './accumulator';
import {
  type OpenAIEndpoint,
  getDefaultEndpoints,
  resolveModelName,
  isRetryableForFallback,
} from './openai-endpoints';

function createEndpointKey(endpoint: OpenAIEndpoint, model?: string): string {
  return `${endpoint.type}:${endpoint.baseUrl ?? 'default'}:${endpoint.apiVersion ?? ''}:${model ?? ''}`;
}

export class OpenAIAdapter implements ModelAdapter {
  private endpoints: OpenAIEndpoint[];
  private clientCache = new Map<string, OpenAI>();

  constructor(endpoints?: OpenAIEndpoint[]) {
    this.endpoints = endpoints ?? getDefaultEndpoints();
  }

  static withDefaults(): OpenAIAdapter {
    return new OpenAIAdapter(getDefaultEndpoints());
  }

  static withFallback(endpoints: OpenAIEndpoint[]): OpenAIAdapter {
    return new OpenAIAdapter(endpoints);
  }

  async *step(
    ctx: RenderContext,
    config: ModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    let lastError: Error | undefined;

    for (let i = 0; i < this.endpoints.length; i++) {
      const endpoint = this.endpoints[i];
      const isLast = i === this.endpoints.length - 1;

      try {
        return yield* this.executeStep(ctx, config, signal, endpoint);
      } catch (error) {
        lastError = error as Error;
        if (isLast || !isRetryableForFallback(error)) {
          throw error;
        }
      }
    }

    throw lastError ?? new Error('No endpoints configured');
  }

  private getOrCreateClient(
    endpoint: OpenAIEndpoint,
    modelName: string,
  ): { client: OpenAI; resolvedModel: string } {
    const resolvedModel = resolveModelName(modelName, endpoint);
    const cacheKey = createEndpointKey(
      endpoint,
      endpoint.type === 'azure' ? resolvedModel : undefined,
    );

    let client = this.clientCache.get(cacheKey);
    if (!client) {
      client = this.createClient(endpoint, resolvedModel);
      this.clientCache.set(cacheKey, client);
    }

    return { client, resolvedModel };
  }

  private createClient(
    endpoint: OpenAIEndpoint,
    resolvedModel: string,
  ): OpenAI {
    if (endpoint.type === 'azure') {
      const base = endpoint.baseUrl!.replace(/\/$/, '');
      const deploymentUrl = `${base}/openai/deployments/${resolvedModel}`;
      return new AzureOpenAI({
        endpoint: deploymentUrl,
        apiVersion: endpoint.apiVersion!,
        apiKey: endpoint.apiKey,
      });
    }

    return new OpenAI({
      apiKey: endpoint.apiKey,
      baseURL: endpoint.baseUrl,
    });
  }

  private async *executeStep(
    ctx: RenderContext,
    config: ModelConfig,
    signal: AbortSignal | undefined,
    endpoint: OpenAIEndpoint,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const reasoning =
      config.provider === 'openai' ? config.reasoning : undefined;
    const retryConfig = config.provider === 'openai' ? config.retry : undefined;
    const { client, resolvedModel } = this.getOrCreateClient(
      endpoint,
      config.name,
    );

    const createStream = async function* (): AsyncGenerator<
      StreamEvent,
      ModelStepResult
    > {
      if (signal?.aborted) {
        throw new Error('Aborted');
      }
      const input = serializeContext(ctx);
      const toolChoice = ctx.toolChoice ?? ctx.agent.toolChoice;
      const serializedTools = serializeTools(ctx.tools);
      const serializedToolChoice = serializeToolChoice(
        toolChoice,
        ctx.allowedTools,
      );
      const useNativeStructuredOutput =
        ctx.outputSchema && ctx.outputMode !== 'prompt';
      const stream = client.responses.stream({
        model: resolvedModel,
        input,
        tools: serializedTools,
        store: false,
        ...(serializedToolChoice && { tool_choice: serializedToolChoice }),
        ...(reasoning && {
          reasoning,
          include: ['reasoning.encrypted_content'],
        }),
        ...(useNativeStructuredOutput && {
          text: {
            format: zodTextFormat(ctx.outputSchema!, 'output_schema'),
          },
        }),
      });

      const cleanup = signal
        ? registerAbortHandler(signal, () => stream.abort())
        : undefined;

      const accumulator = createStreamAccumulator();

      try {
        for await (const event of stream) {
          if (signal?.aborted) {
            throw new Error('Aborted');
          }

          let rawEvent: RawDeltaEvent | null = null;

          if (event.type === 'response.reasoning_summary_text.delta') {
            rawEvent = {
              id: createEventId(),
              type: 'thought_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta,
            };
          } else if (event.type === 'response.output_text.delta') {
            rawEvent = {
              id: createEventId(),
              type: 'assistant_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta,
            };
          }

          if (rawEvent) {
            yield accumulator.push(rawEvent);
          }
        }

        const response = await stream.finalResponse();
        return parseResponse(
          response,
          endpoint,
          ctx.invocationId,
          ctx.agentName,
          accumulator.getAccumulatedText(),
        );
      } finally {
        cleanup?.();
      }
    };

    return yield* withStreamRetry(createStream, {
      config: retryConfig,
      signal,
    });
  }
}

function registerAbortHandler(
  signal: AbortSignal,
  handler: () => void,
): () => void {
  signal.addEventListener('abort', handler);
  return () => signal.removeEventListener('abort', handler);
}

export function serializeContext(ctx: RenderContext): ResponseInputItem[] {
  return ctx.events.flatMap((event): ResponseInputItem[] => {
    switch (event.type) {
      case 'system':
        return [{ role: 'system', content: event.text }];
      case 'user':
        return [{ role: 'user', content: event.text }];
      case 'assistant':
        return [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: event.text }],
          } as ResponseInputItem,
        ];
      case 'thought': {
        const providerCtx = getOpenAIContext(event) as
          | ResponseReasoningItem
          | undefined;
        if (providerCtx?.encrypted_content) {
          return [
            {
              type: 'reasoning' as const,
              id: providerCtx.id,
              summary: providerCtx.summary,
              encrypted_content: providerCtx.encrypted_content,
            } as ResponseInputItem,
          ];
        }
        return [];
      }
      case 'tool_call': {
        const providerCtx = getOpenAIContext(event) as
          | ResponseFunctionToolCall
          | undefined;
        return [
          {
            type: 'function_call',
            id: providerCtx?.id ?? event.callId,
            call_id: providerCtx?.call_id ?? event.callId,
            name: event.name,
            arguments: JSON.stringify(event.args),
          } as ResponseInputItem,
        ];
      }
      case 'tool_result': {
        const providerCtx = getOpenAIContext(event) as
          | ResponseFunctionToolCall
          | undefined;
        return [
          {
            type: 'function_call_output',
            call_id: providerCtx?.call_id ?? event.callId,
            output: event.error ?? JSON.stringify(event.result),
          } as ResponseInputItem,
        ];
      }
      default:
        return [];
    }
  });
}

interface OpenAIUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIResponse {
  output: ResponseOutputItem[];
  status?: string;
  usage?: OpenAIUsage;
}

function parseUsage(usage?: OpenAIUsage): ModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    outputTokens: usage.output_tokens,
  };
}

function parseFinishReason(
  status?: string,
  hasToolCalls?: boolean,
): ModelEndEvent['finishReason'] {
  if (hasToolCalls) return 'tool_calls';
  if (status === 'completed') return 'stop';
  if (status === 'failed') return 'error';
  if (status === 'incomplete') return 'length';
  return 'stop';
}

export function parseResponse(
  response: OpenAIResponse,
  endpoint: OpenAIEndpoint,
  invocationId: string,
  agentName: string,
  streamedText?: AccumulatedText,
): ModelStepResult {
  const stepEvents: Event[] = [];
  const toolCalls: ToolCallEvent[] = [];
  const providerName = endpoint.type === 'azure' ? 'azure-openai' : 'openai';

  for (const item of response.output) {
    const createdAt = Date.now();

    if (item.type === 'reasoning') {
      const reasoning = item as ResponseReasoningItem;
      const summaryText =
        reasoning.summary
          ?.filter((s) => s.type === 'summary_text')
          .map((s) => s.text)
          .join('\n') ?? '';
      const text = summaryText || streamedText?.thoughtText || '';
      stepEvents.push({
        id: createEventId(),
        type: 'thought',
        createdAt,
        invocationId,
        agentName,
        text,
        providerContext: { provider: providerName, data: reasoning },
      } as Event);
    }

    if (item.type === 'function_call') {
      const fn = item as ResponseFunctionToolCall;
      const toolCall: ToolCallEvent = {
        id: createEventId(),
        type: 'tool_call',
        createdAt,
        invocationId,
        agentName,
        callId: createCallId(),
        name: fn.name,
        args: JSON.parse(fn.arguments) as Record<string, unknown>,
        providerContext: { provider: providerName, data: fn },
      };
      stepEvents.push(toolCall);
      toolCalls.push(toolCall);
    }

    if (item.type === 'message') {
      const msg = item as ResponseOutputMessage;
      const text = msg.content
        ?.filter((c) => c.type === 'output_text')
        .map((c) => (c as { text: string }).text)
        .join('\n');
      if (text) {
        stepEvents.push({
          id: createEventId(),
          type: 'assistant',
          createdAt,
          invocationId,
          agentName,
          text,
          providerContext: { provider: providerName, data: msg },
        } as Event);
      }
    }
  }

  return {
    stepEvents,
    toolCalls,
    terminal: toolCalls.length === 0,
    usage: parseUsage(response.usage),
    finishReason: parseFinishReason(response.status, toolCalls.length > 0),
  };
}

export function serializeTools(tools: Tool[]) {
  return tools.map((t) => {
    const fn = zodResponsesFunction({
      name: t.name,
      description: t.description,
      parameters: t.schema as z.ZodType,
    });
    return {
      type: 'function' as const,
      name: fn.name,
      description: fn.description ?? t.description,
      parameters: fn.parameters ?? {},
      strict: true,
    };
  });
}

function getOpenAIContext(
  event: Pick<Event, 'providerContext'>,
): ResponseOutputItem | undefined {
  const provider = event.providerContext?.provider;
  if (provider === 'openai' || provider === 'azure-openai') {
    return event.providerContext?.data as ResponseOutputItem;
  }
  return undefined;
}

export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }
  | {
      type: 'allowed_tools';
      mode: 'auto' | 'required';
      tools: Array<{ type: 'function'; name: string }>;
    };

export function serializeToolChoice(
  choice: ToolChoice | undefined,
  allowedTools?: string[],
): OpenAIToolChoice | undefined {
  if (allowedTools && allowedTools.length > 0) {
    const mode = choice === 'required' ? 'required' : 'auto';
    return {
      type: 'allowed_tools',
      mode,
      tools: allowedTools.map((name) => ({ type: 'function', name })),
    };
  }
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}
