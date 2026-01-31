import {
  GoogleGenAI,
  ThinkingLevel,
  FunctionCallingConfigMode,
  type Content,
  type Part,
  type FunctionCall,
  type Schema,
  type ToolConfig,
  // @ts-ignore @google/genai is ESM-only but bundler handles it
} from '@google/genai';
import { z } from 'zod';
import { zodResponsesFunction } from 'openai/helpers/zod';
import type {
  ModelStepResult,
  ModelAdapter,
  ModelConfig,
  Event,
  RenderContext,
  FunctionTool,
  StreamEvent,
  ToolCallEvent,
  ModelUsage,
  ModelEndEvent,
  ToolChoice,
  VertexAIConfig,
} from '../types';
import { createEventId, createCallId } from '../session';
import { withStreamRetry } from '../core';
import { createStreamAccumulator, type RawDeltaEvent } from './accumulator';

const normalizeText = (text: string) => text.replace(/\n{3,}/g, '\n\n').trim();

export interface GeminiAdapterConfig {
  apiKey?: string;
  vertex?: VertexAIConfig;
}

function createClientKey(config: GeminiAdapterConfig): string {
  if (config.vertex) {
    const creds = config.vertex.credentials ?? 'env';
    return `vertex:${config.vertex.project}:${config.vertex.location}:${creds}`;
  }
  return `apikey:${config.apiKey ?? 'env'}`;
}

export class GeminiAdapter implements ModelAdapter {
  private defaultConfig: GeminiAdapterConfig;
  private clientCache = new Map<string, GoogleGenAI>();

  constructor(config?: GeminiAdapterConfig | string) {
    if (typeof config === 'string') {
      this.defaultConfig = { apiKey: config };
    } else {
      this.defaultConfig = config ?? {};
    }
  }

  private getClient(modelConfig: ModelConfig): GoogleGenAI {
    const vertexConfig =
      modelConfig.provider === 'gemini' ? modelConfig.vertex : undefined;

    const effectiveConfig: GeminiAdapterConfig = vertexConfig
      ? { vertex: vertexConfig }
      : this.defaultConfig;

    const cacheKey = createClientKey(effectiveConfig);
    let client = this.clientCache.get(cacheKey);

    if (!client) {
      client = this.createClient(effectiveConfig);
      this.clientCache.set(cacheKey, client);
    }

    return client;
  }

  private createClient(config: GeminiAdapterConfig): GoogleGenAI {
    if (config.vertex) {
      const credentials =
        config.vertex.credentials ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!credentials) {
        throw new Error(
          `No Google Cloud credentials configured.

Either:
- Set GOOGLE_APPLICATION_CREDENTIALS environment variable to credentials JSON file path
- Pass credentials path in vertex config: vertex: { project, location, credentials: "/path/to/credentials.json" } (recommended)`,
        );
      }
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
      return new GoogleGenAI({
        vertexai: true,
        project: config.vertex.project,
        location: config.vertex.location,
      });
    }

    const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        `No Gemini API key configured.

Either:
- Pass apiKey to GeminiAdapter constructor
- Set GEMINI_API_KEY environment variable
- Use vertex config for Google Cloud authentication`,
      );
    }

    return new GoogleGenAI({ apiKey });
  }

  async *step(
    ctx: RenderContext,
    config: ModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const thinkingConfig =
      config.provider === 'gemini'
        ? mapThinkingConfig(config.thinkingConfig)
        : undefined;
    const retryConfig = config.provider === 'gemini' ? config.retry : undefined;
    const { contents, systemInstruction } = serializeContext(ctx);
    const client = this.getClient(config);

    const createStream = async function* (): AsyncGenerator<
      StreamEvent,
      ModelStepResult
    > {
      if (signal?.aborted) {
        throw new Error('Aborted');
      }

      const allParts: Part[] = [];
      const accumulator = createStreamAccumulator();
      let usageMetadata: GeminiUsage | undefined;
      let finishReason: string | undefined;

      const toolChoice = ctx.toolChoice ?? ctx.agent.toolChoice;
      const useNativeStructuredOutput =
        ctx.outputSchema && ctx.outputMode !== 'prompt';
      const stream = await client.models.generateContentStream({
        model: config.name,
        contents,
        config: {
          systemInstruction,
          tools: serializeTools(ctx.functionTools),
          toolConfig: serializeToolConfig(toolChoice, ctx.allowedTools),
          thinkingConfig,
          ...(useNativeStructuredOutput && {
            responseMimeType: 'application/json',
            responseSchema: zodToGeminiSchema(ctx.outputSchema!),
          }),
        },
      });

      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw new Error('Aborted');
        }

        if (chunk.usageMetadata) {
          usageMetadata = chunk.usageMetadata as GeminiUsage;
        }
        if (chunk.candidates?.[0]?.finishReason) {
          finishReason = chunk.candidates[0].finishReason;
        }

        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          allParts.push(part);

          let rawEvent: RawDeltaEvent | null = null;

          if (part.thought && part.text) {
            rawEvent = {
              id: createEventId(),
              type: 'thought_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: normalizeText(part.text) + '\n',
            };
          } else if (part.text && !part.thought) {
            rawEvent = {
              id: createEventId(),
              type: 'assistant_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: normalizeText(part.text),
            };
          }

          if (rawEvent) {
            yield accumulator.push(rawEvent);
          }
        }
      }

      return parseResponse(
        allParts,
        usageMetadata,
        finishReason,
        ctx.invocationId,
        ctx.agentName,
      );
    };

    return yield* withStreamRetry(createStream, {
      config: retryConfig,
      signal,
    });
  }
}

function getGeminiContext(
  event: Pick<Event, 'providerContext'>,
): Part | undefined {
  if (event.providerContext?.provider === 'gemini') {
    return event.providerContext.data as Part;
  }
  return undefined;
}

export function serializeContext(ctx: RenderContext): {
  contents: Content[];
  systemInstruction: string | undefined;
} {
  const contents: Content[] = [];
  const systemParts: string[] = [];

  type RoleGroup = { role: 'user' | 'model'; parts: Part[] };
  let current: RoleGroup | null = null;

  const pushPart = (role: 'user' | 'model', part: Part) => {
    if (current?.role !== role) {
      if (current) contents.push(current);
      current = { role, parts: [] };
    }
    current.parts.push(part);
  };

  for (const event of ctx.events) {
    const geminiCtx = getGeminiContext(event);

    switch (event.type) {
      case 'system':
        systemParts.push(event.text);
        break;

      case 'user':
        pushPart('user', { text: event.text });
        break;

      case 'assistant': {
        const part: Part = { text: event.text };
        if (geminiCtx?.thoughtSignature) {
          part.thoughtSignature = geminiCtx.thoughtSignature;
        }
        pushPart('model', part);
        break;
      }

      case 'thought': {
        if (!event.text) break;
        if (geminiCtx?.thoughtSignature) {
          pushPart('model', {
            thought: true,
            text: event.text,
            thoughtSignature: geminiCtx.thoughtSignature,
          });
        } else {
          pushPart('model', { text: event.text });
        }
        break;
      }

      case 'tool_call': {
        const part: Part = {
          functionCall: geminiCtx?.functionCall ?? {
            name: event.name,
            args: event.args,
          },
        };
        if (geminiCtx?.thoughtSignature) {
          part.thoughtSignature = geminiCtx.thoughtSignature;
        }
        pushPart('model', part);
        break;
      }

      case 'tool_result':
        pushPart('user', {
          functionResponse: {
            name: event.name,
            response: event.error
              ? { error: event.error }
              : (event.result as Record<string, unknown>),
          },
        });
        break;
    }
  }

  if (current) contents.push(current);

  return {
    contents,
    systemInstruction:
      systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  };
}

interface GeminiUsage {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

function parseGeminiUsage(usage?: GeminiUsage): ModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    cachedTokens: usage.cachedContentTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

function parseGeminiFinishReason(
  reason?: string,
  hasToolCalls?: boolean,
): ModelEndEvent['finishReason'] {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter';
  if (reason === 'ERROR') return 'error';
  return 'stop';
}

export function parseResponse(
  parts: Part[],
  usage: GeminiUsage | undefined,
  finishReason: string | undefined,
  invocationId: string,
  agentName: string,
): ModelStepResult {
  const createdAt = Date.now();

  const thoughtParts = parts.filter((p) => p.thought && p.text);
  const assistantParts = parts.filter(
    (p) => p.text && !p.thought && !p.functionCall,
  );
  const functionParts = parts.filter((p) => p.functionCall);

  const thoughtText = normalizeText(thoughtParts.map((p) => p.text).join(''));
  const assistantText = normalizeText(
    assistantParts.map((p) => p.text).join(''),
  );

  const sharedSignature = parts.find(
    (p) => p.thoughtSignature,
  )?.thoughtSignature;

  const thoughtEvent: Event | null = thoughtText
    ? ({
        id: createEventId(),
        type: 'thought',
        createdAt,
        invocationId,
        agentName,
        text: thoughtText,
        providerContext: sharedSignature
          ? { provider: 'gemini', data: { thoughtSignature: sharedSignature } }
          : undefined,
      } as Event)
    : null;

  const assistantEvent: Event | null = assistantText
    ? ({
        id: createEventId(),
        type: 'assistant',
        createdAt,
        invocationId,
        agentName,
        text: assistantText,
        providerContext: sharedSignature
          ? { provider: 'gemini', data: { thoughtSignature: sharedSignature } }
          : undefined,
      } as Event)
    : null;

  const toolCalls: ToolCallEvent[] = functionParts.map((part, index) => {
    const fn = part.functionCall as FunctionCall;
    const signature =
      index === 0
        ? (part.thoughtSignature ?? sharedSignature)
        : part.thoughtSignature;

    return {
      id: createEventId(),
      type: 'tool_call',
      createdAt,
      invocationId,
      agentName,
      callId: createCallId(),
      name: fn.name!,
      args: (fn.args ?? {}) as Record<string, unknown>,
      providerContext: {
        provider: 'gemini',
        data: {
          functionCall: part.functionCall,
          ...(signature && { thoughtSignature: signature }),
        },
      },
    };
  });

  const stepEvents: Event[] = [
    ...(thoughtEvent ? [thoughtEvent] : []),
    ...toolCalls,
    ...(assistantEvent ? [assistantEvent] : []),
  ];

  return {
    stepEvents,
    toolCalls,
    terminal: toolCalls.length === 0,
    usage: parseGeminiUsage(usage),
    finishReason: parseGeminiFinishReason(finishReason, toolCalls.length > 0),
  };
}

export function serializeTools(tools: FunctionTool[]) {
  if (tools.length === 0) return [];

  return [
    {
      functionDeclarations: tools.map((t) => {
        const fn = zodResponsesFunction({
          name: t.name,
          description: t.description,
          parameters: t.schema as z.ZodType,
        });
        return {
          name: fn.name,
          description: fn.description ?? t.description,
          parameters: fn.parameters as Schema,
        };
      }),
    },
  ];
}

const THINKING_LEVEL_MAP: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

function mapThinkingConfig(config?: {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
}) {
  if (!config) return undefined;
  return {
    ...config,
    thinkingLevel: config.thinkingLevel
      ? THINKING_LEVEL_MAP[config.thinkingLevel]
      : undefined,
  };
}

function zodToGeminiSchema(schema: z.ZodType): Schema {
  const fn = zodResponsesFunction({
    name: 'output',
    description: 'Output schema',
    parameters: schema,
  });
  return fn.parameters as Schema;
}

export function serializeToolConfig(
  choice: ToolChoice | undefined,
  allowedTools?: string[],
): ToolConfig | undefined {
  if (!choice && !allowedTools) return undefined;

  if (allowedTools && allowedTools.length > 0) {
    const mode =
      choice === 'required'
        ? FunctionCallingConfigMode.ANY
        : FunctionCallingConfigMode.AUTO;
    return {
      functionCallingConfig: {
        mode,
        allowedFunctionNames: allowedTools,
      },
    };
  }

  if (choice === 'none') {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
  }

  if (choice === 'required') {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
  }

  if (typeof choice === 'object' && 'name' in choice) {
    return {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: [choice.name],
      },
    };
  }

  return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
}
