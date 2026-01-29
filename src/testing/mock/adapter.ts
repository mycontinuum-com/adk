import type {
  ModelAdapter,
  ModelStepResult,
  RenderContext,
  ModelConfig,
  StreamEvent,
  ToolCallEvent,
  Event,
} from '../../types';
import { createEventId, createCallId } from '../../session';
import type { MockResponseConfig } from '../runTest';

export interface MockAdapterConfig {
  responses?: MockResponseConfig[];
  defaultResponse?: MockResponseConfig;
}

export class MockAdapter implements ModelAdapter {
  private responses: MockResponseConfig[] = [];
  private responseIndex = 0;
  private fallbackResponse: MockResponseConfig;

  private routedResponses = new Map<string, MockResponseConfig[]>();
  private routeIndices = new Map<string, number>();
  private callCount = 0;

  public stepCalls: Array<{ ctx: RenderContext; config: ModelConfig }> = [];

  constructor(config: MockAdapterConfig = {}) {
    this.responses = config.responses ?? [];
    this.fallbackResponse = config.defaultResponse ?? { text: 'Mock response' };
  }

  reset(): void {
    this.responseIndex = 0;
    this.routeIndices.clear();
    this.callCount = 0;
    this.stepCalls = [];
  }

  setResponses(responses: MockResponseConfig[]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }

  addResponses(key: string, responses: MockResponseConfig[]): void {
    const existing = this.routedResponses.get(key) ?? [];
    this.routedResponses.set(key, [...existing, ...responses]);
  }

  clearRoutes(): void {
    this.routedResponses.clear();
    this.routeIndices.clear();
  }

  private getRoutedResponse(key: string): MockResponseConfig | undefined {
    const responses = this.routedResponses.get(key);
    if (!responses?.length) return undefined;

    const index = this.routeIndices.get(key) ?? 0;
    if (index >= responses.length) return undefined;

    this.routeIndices.set(key, index + 1);
    return responses[index];
  }

  private getNextResponse(ctx: RenderContext): MockResponseConfig {
    const agentName = ctx.agent.name;
    const stepIndex = this.callCount;

    const byName = this.getRoutedResponse(`agent:${agentName}`);
    if (byName) return byName;

    const byStepIndex = this.getRoutedResponse(`step:${stepIndex}`);
    if (byStepIndex) return byStepIndex;

    const byBranchIndex = this.getRoutedResponse(`branch:${stepIndex}`);
    if (byBranchIndex) return byBranchIndex;

    if (this.responseIndex < this.responses.length) {
      return this.responses[this.responseIndex++];
    }

    return this.fallbackResponse;
  }

  async *step(
    ctx: RenderContext,
    config: ModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    this.stepCalls.push({ ctx, config });
    const response = this.getNextResponse(ctx);
    const invocationId = ctx.invocationId;
    this.callCount++;

    if (response.error) throw response.error;
    if (signal?.aborted) throw new Error('Aborted');

    if (response.delayMs) {
      await this.sleep(response.delayMs, signal);
    }

    if (signal?.aborted) throw new Error('Aborted');

    const stepEvents: Event[] = [];
    const toolCalls: ToolCallEvent[] = [];
    const createdAt = Date.now();

    const agentName = ctx.agentName;

    if (response.thought) {
      if (response.streamChunks) {
        const chunks = this.chunkText(
          response.thought,
          response.chunkSize ?? 10,
        );
        let accumulated = '';
        for (const chunk of chunks) {
          accumulated += chunk;
          yield {
            id: createEventId(),
            type: 'thought_delta',
            createdAt: Date.now(),
            invocationId,
            agentName,
            delta: chunk,
            text: accumulated,
          };
        }
      }
      stepEvents.push({
        id: createEventId(),
        type: 'thought',
        createdAt,
        invocationId,
        agentName,
        text: response.thought,
      } as Event);
    }

    if (response.text) {
      if (response.streamChunks) {
        const chunks = this.chunkText(response.text, response.chunkSize ?? 10);
        let accumulated = '';
        for (const chunk of chunks) {
          accumulated += chunk;
          yield {
            id: createEventId(),
            type: 'assistant_delta',
            createdAt: Date.now(),
            invocationId,
            agentName,
            delta: chunk,
            text: accumulated,
          };
        }
      }
      stepEvents.push({
        id: createEventId(),
        type: 'assistant',
        createdAt,
        invocationId,
        agentName,
        text: response.text,
      } as Event);
    }

    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        const toolCall: ToolCallEvent = {
          id: createEventId(),
          type: 'tool_call',
          createdAt,
          invocationId,
          agentName,
          callId: createCallId(),
          name: tc.name,
          args: tc.args,
        };
        stepEvents.push(toolCall);
        toolCalls.push(toolCall);
      }
    }

    return {
      stepEvents,
      toolCalls,
      terminal: toolCalls.length === 0,
    };
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      const timeout = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
      });
    });
  }

  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }
}
