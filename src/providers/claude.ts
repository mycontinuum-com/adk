import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { z } from 'zod';
import { zodResponsesFunction } from 'openai/helpers/zod';
import type {
  ModelStepResult,
  ModelAdapter,
  ModelConfig,
  ClaudeModel,
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
import { createStreamAccumulator, type RawDeltaEvent } from './accumulator';

interface TextBlock {
  type: 'text';
  text: string;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  inputJson: string;
}

type ParsedContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock;

interface MessageParam {
  role: 'user' | 'assistant';
  content: ContentBlockParam[] | string;
}

interface TextBlockParam {
  type: 'text';
  text: string;
}

interface ToolUseBlockParam {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface ThinkingBlockParam {
  type: 'thinking';
  thinking: string;
  signature: string;
}

type ContentBlockParam =
  | TextBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlock;

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

function createClientKey(config: ClaudeModel['vertex']): string {
  const creds = config.credentials ?? 'env';
  return `${config.project}:${config.location}:${creds}`;
}

export class ClaudeAdapter implements ModelAdapter {
  private clientCache = new Map<string, AnthropicVertex>();

  private getClient(modelConfig: ModelConfig): AnthropicVertex {
    if (modelConfig.provider !== 'claude') {
      throw new Error(`ClaudeAdapter received non-claude model config`);
    }

    const cacheKey = createClientKey(modelConfig.vertex);
    let client = this.clientCache.get(cacheKey);

    if (!client) {
      const credentials =
        modelConfig.vertex.credentials ??
        process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!credentials) {
        throw new Error(
          `No Google Cloud credentials configured.

Either:
  - Pass credentials path in vertex config: vertex: { project, location, credentials: "/path/to/credentials.json" }
  - Set GOOGLE_APPLICATION_CREDENTIALS environment variable`,
        );
      }
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
      client = new AnthropicVertex({
        projectId: modelConfig.vertex.project,
        region: modelConfig.vertex.location,
      });
      this.clientCache.set(cacheKey, client);
    }

    return client;
  }

  async *step(
    ctx: RenderContext,
    config: ModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    if (config.provider !== 'claude') {
      throw new Error(`ClaudeAdapter received non-claude model config`);
    }

    const retryConfig = config.retry;
    const thinkingConfig = config.thinking;
    const { messages, system } = serializeContext(ctx);
    const client = this.getClient(config);

    const createStream = async function* (): AsyncGenerator<
      StreamEvent,
      ModelStepResult
    > {
      if (signal?.aborted) {
        throw new Error('Aborted');
      }

      const accumulator = createStreamAccumulator();
      const contentBlocks: ParsedContentBlock[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | null = null;

      let toolChoice = ctx.toolChoice ?? ctx.agent.toolChoice;
      if (
        thinkingConfig &&
        toolChoice !== 'auto' &&
        toolChoice !== 'none' &&
        toolChoice !== undefined
      ) {
        toolChoice = 'auto';
      }

      const response = await client.messages.create({
        model: config.name,
        max_tokens: config.maxTokens ?? 4096,
        ...(system && { system }),
        messages,
        ...(ctx.tools.length > 0 && {
          tools: serializeTools(ctx.tools),
          tool_choice: serializeToolChoice(
            toolChoice,
            thinkingConfig ? undefined : ctx.allowedTools,
          ),
        }),
        ...(thinkingConfig && {
          thinking: {
            type: 'enabled' as const,
            budget_tokens: thinkingConfig.budgetTokens ?? 1024,
          },
        }),
        stream: true,
      });

      for await (const event of response) {
        if (signal?.aborted) {
          throw new Error('Aborted');
        }

        if (event.type === 'message_start') {
          inputTokens = event.message.usage?.input_tokens ?? 0;
        }

        if (event.type === 'message_delta') {
          outputTokens = event.usage?.output_tokens ?? 0;
          stopReason = event.delta?.stop_reason ?? null;
        }

        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'text') {
            contentBlocks.push({ type: 'text', text: '' });
          } else if (block.type === 'thinking') {
            contentBlocks.push({
              type: 'thinking',
              thinking: '',
              signature: '',
            });
          } else if (block.type === 'redacted_thinking') {
            contentBlocks.push({ type: 'redacted_thinking', data: block.data });
          } else if (block.type === 'tool_use') {
            contentBlocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              inputJson: '',
            });
          }
        }

        if (event.type === 'content_block_delta') {
          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (!lastBlock) continue;

          if (event.delta.type === 'text_delta' && lastBlock.type === 'text') {
            lastBlock.text += event.delta.text;
            const rawEvent: RawDeltaEvent = {
              id: createEventId(),
              type: 'assistant_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta.text,
            };
            yield accumulator.push(rawEvent);
          }

          if (
            event.delta.type === 'thinking_delta' &&
            lastBlock.type === 'thinking'
          ) {
            lastBlock.thinking += event.delta.thinking;
            const rawEvent: RawDeltaEvent = {
              id: createEventId(),
              type: 'thought_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta.thinking,
            };
            yield accumulator.push(rawEvent);
          }

          if (
            event.delta.type === 'input_json_delta' &&
            lastBlock.type === 'tool_use'
          ) {
            lastBlock.inputJson += event.delta.partial_json || '';
          }

          if (
            event.delta.type === 'signature_delta' &&
            lastBlock.type === 'thinking'
          ) {
            lastBlock.signature += event.delta.signature || '';
          }
        }
      }

      return parseResponse(
        contentBlocks,
        { inputTokens, outputTokens },
        stopReason,
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

export function serializeContext(ctx: RenderContext): {
  messages: MessageParam[];
  system: string | undefined;
} {
  const messages: MessageParam[] = [];
  const systemParts: string[] = [];
  const toolUseIdMap = new Map<string, string>();

  type ClaudeRole = 'user' | 'assistant';
  let currentRole: ClaudeRole | null = null;
  let currentContent: ContentBlockParam[] = [];

  const flushCurrent = () => {
    if (currentRole && currentContent.length > 0) {
      messages.push({ role: currentRole, content: currentContent });
    }
    currentContent = [];
  };

  const pushContent = (role: ClaudeRole, block: ContentBlockParam) => {
    if (currentRole !== role) {
      flushCurrent();
      currentRole = role;
    }
    currentContent.push(block);
  };

  for (const event of ctx.events) {
    switch (event.type) {
      case 'system':
        systemParts.push(event.text);
        break;

      case 'user':
        pushContent('user', { type: 'text', text: event.text });
        break;

      case 'assistant':
        pushContent('assistant', { type: 'text', text: event.text });
        break;

      case 'thought': {
        const thinkingCtx = getClaudeContext(event);
        if (thinkingCtx?.redacted) {
          pushContent('assistant', {
            type: 'redacted_thinking',
            data: thinkingCtx.data as string,
          });
        } else {
          pushContent('assistant', {
            type: 'thinking',
            thinking: event.text,
            signature: thinkingCtx?.signature ?? '',
          });
        }
        break;
      }

      case 'tool_call': {
        const providerCtx = getClaudeContext(event);
        const toolUseId = providerCtx?.id ?? event.callId;
        toolUseIdMap.set(event.callId, toolUseId);
        pushContent('assistant', {
          type: 'tool_use',
          id: toolUseId,
          name: event.name,
          input: event.args,
        });
        break;
      }

      case 'tool_result': {
        const toolUseId = toolUseIdMap.get(event.callId) ?? event.callId;
        pushContent('user', {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: event.error ?? JSON.stringify(event.result),
          ...(event.error && { is_error: true }),
        });
        break;
      }
    }
  }

  flushCurrent();

  return {
    messages,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  };
}

function getClaudeContext(
  event: Pick<Event, 'providerContext'>,
):
  | {
      id?: string;
      tool_use_id?: string;
      signature?: string;
      redacted?: boolean;
      data?: string;
    }
  | undefined {
  if (event.providerContext?.provider === 'claude') {
    return event.providerContext.data as {
      id?: string;
      tool_use_id?: string;
      signature?: string;
      redacted?: boolean;
      data?: string;
    };
  }
  return undefined;
}

interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
}

function parseClaudeUsage(usage: ClaudeUsage): ModelUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function parseClaudeFinishReason(
  reason: string | null,
  hasToolCalls: boolean,
): ModelEndEvent['finishReason'] {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'end_turn') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'stop_sequence') return 'stop';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

export function parseResponse(
  blocks: ParsedContentBlock[],
  usage: ClaudeUsage,
  stopReason: string | null,
  invocationId: string,
  agentName: string,
): ModelStepResult {
  const createdAt = Date.now();
  const stepEvents: Event[] = [];
  const toolCalls: ToolCallEvent[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'thinking':
        if (block.thinking) {
          stepEvents.push({
            id: createEventId(),
            type: 'thought',
            createdAt,
            invocationId,
            agentName,
            text: block.thinking,
            providerContext: {
              provider: 'claude',
              data: { signature: block.signature },
            },
          } as Event);
        }
        break;

      case 'redacted_thinking':
        stepEvents.push({
          id: createEventId(),
          type: 'thought',
          createdAt,
          invocationId,
          agentName,
          text: '[redacted]',
          providerContext: {
            provider: 'claude',
            data: { redacted: true, data: block.data },
          },
        } as Event);
        break;

      case 'text':
        if (block.text) {
          stepEvents.push({
            id: createEventId(),
            type: 'assistant',
            createdAt,
            invocationId,
            agentName,
            text: block.text,
          } as Event);
        }
        break;

      case 'tool_use': {
        let args: Record<string, unknown> = {};
        try {
          args = block.inputJson ? JSON.parse(block.inputJson) : {};
        } catch {
          args = {};
        }
        const toolCall: ToolCallEvent = {
          id: createEventId(),
          type: 'tool_call',
          createdAt,
          invocationId,
          agentName,
          callId: createCallId(),
          name: block.name,
          args,
          providerContext: {
            provider: 'claude',
            data: { id: block.id },
          },
        };
        stepEvents.push(toolCall);
        toolCalls.push(toolCall);
        break;
      }
    }
  }

  return {
    stepEvents,
    toolCalls,
    terminal: toolCalls.length === 0,
    usage: parseClaudeUsage(usage),
    finishReason: parseClaudeFinishReason(stopReason, toolCalls.length > 0),
  };
}

export function serializeTools(tools: Tool[]): ClaudeTool[] {
  return tools.map((t) => {
    const fn = zodResponsesFunction({
      name: t.name,
      description: t.description,
      parameters: t.schema as z.ZodType,
    });
    return {
      name: fn.name,
      description: fn.description ?? t.description,
      input_schema: {
        type: 'object' as const,
        ...fn.parameters,
      },
    };
  });
}

type ClaudeToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string };

export function serializeToolChoice(
  choice: ToolChoice | undefined,
  allowedTools?: string[],
): ClaudeToolChoice {
  if (allowedTools && allowedTools.length === 1) {
    return { type: 'tool', name: allowedTools[0] };
  }

  if (!choice || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object' && 'name' in choice) {
    return { type: 'tool', name: choice.name };
  }

  return { type: 'auto' };
}
