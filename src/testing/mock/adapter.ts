import type { Answer, DecisionRequest, DecisionResponse } from '../../types/decisions'
import type { StreamEvent, ToolCallEvent, Event } from '../../types/events'
import type {
  ModelAdapter,
  ModelStepResult,
  RenderContext,
  ProviderModelConfig,
} from '../../types/runnables'
import type { MockResponseConfig } from '../runTest'

import { createEventId, createCallId } from '../../session'

export interface MockAdapterConfig {
  responses?: MockResponseConfig[]
  defaultResponse?: MockResponseConfig
  /**
   * The answer `decide` gives each question, by question name. A question with no answer here fails
   * the call.
   */
  decisions?: Record<string, Answer>
}

export class MockAdapter implements ModelAdapter {
  private responses: MockResponseConfig[] = []
  private responseIndex = 0
  private fallbackResponse: MockResponseConfig

  private routedResponses = new Map<string, MockResponseConfig[]>()
  private routeIndices = new Map<string, number>()
  private callCount = 0

  public stepCalls: Array<{ ctx: RenderContext; config: ProviderModelConfig }> = []
  /** Each request `decide` was given, in order, with the model it was asked for. */
  public decideCalls: Array<{ request: DecisionRequest; config: ProviderModelConfig }> = []
  private readonly decisions: Record<string, Answer>

  constructor(config: MockAdapterConfig = {}) {
    this.responses = config.responses ?? []
    this.fallbackResponse = config.defaultResponse ?? { text: 'Mock response' }
    this.decisions = config.decisions ?? {}
  }

  reset(): void {
    this.responseIndex = 0
    this.routeIndices.clear()
    this.callCount = 0
    this.stepCalls = []
    this.decideCalls = []
  }

  /**
   * Answers each question with its scripted answer from `decisions`. `app.decide` then checks the
   * answers against the questions, so a scripted answer must suit its question.
   *
   * @throws When a question has no scripted answer, naming it, or when `signal` is aborted.
   */
  async decide(
    request: DecisionRequest,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): Promise<DecisionResponse> {
    const decisions = this.decisions
    this.decideCalls.push({ request, config })
    signal?.throwIfAborted()

    const names = Object.keys(request.questions)
    const unscripted = names.filter((name) => !Object.hasOwn(decisions, name))
    if (unscripted.length > 0) {
      throw new Error(`MockAdapter has no scripted decision for: ${unscripted.join(', ')}`)
    }
    return { answers: Object.fromEntries(names.map((name) => [name, decisions[name]])) }
  }

  setResponses(responses: MockResponseConfig[]): void {
    this.responses = responses
    this.responseIndex = 0
  }

  addResponses(key: string, responses: MockResponseConfig[]): void {
    const existing = this.routedResponses.get(key) ?? []
    this.routedResponses.set(key, [...existing, ...responses])
  }

  clearRoutes(): void {
    this.routedResponses.clear()
    this.routeIndices.clear()
  }

  private getRoutedResponse(key: string): MockResponseConfig | undefined {
    const responses = this.routedResponses.get(key)
    if (!responses?.length) return undefined

    const index = this.routeIndices.get(key) ?? 0
    if (index >= responses.length) return undefined

    this.routeIndices.set(key, index + 1)
    return responses[index]
  }

  private getNextResponse(ctx: RenderContext): MockResponseConfig {
    const agentName = ctx.agent.name
    const stepIndex = this.callCount

    const byName = this.getRoutedResponse(`agent:${agentName}`)
    if (byName) return byName

    const byStepIndex = this.getRoutedResponse(`step:${stepIndex}`)
    if (byStepIndex) return byStepIndex

    const byBranchIndex = this.getRoutedResponse(`branch:${stepIndex}`)
    if (byBranchIndex) return byBranchIndex

    if (this.responseIndex < this.responses.length) {
      return this.responses[this.responseIndex++]
    }

    return this.fallbackResponse
  }

  async *step(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    this.stepCalls.push({ ctx, config })
    const response = this.getNextResponse(ctx)
    const invocationId = ctx.invocationId
    this.callCount++

    if (response.error) throw response.error
    if (signal?.aborted) throw new Error('Aborted')

    if (response.delayMs) {
      await this.sleep(response.delayMs, signal)
    }

    if (signal?.aborted) throw new Error('Aborted')

    const stepEvents: Event[] = []
    const toolCalls: ToolCallEvent[] = []
    const createdAt = Date.now()

    const agentName = ctx.agentName

    if (response.thought) {
      if (response.streamChunks) {
        const chunks = this.chunkText(response.thought, response.chunkSize ?? 10)
        let accumulated = ''
        for (const chunk of chunks) {
          accumulated += chunk
          yield {
            id: createEventId(),
            type: 'thought_delta',
            createdAt: Date.now(),
            invocationId,
            agentName,
            delta: chunk,
            text: accumulated,
          }
        }
      }
      stepEvents.push({
        id: createEventId(),
        type: 'thought',
        createdAt,
        invocationId,
        agentName,
        text: response.thought,
      } as Event)
    }

    if (response.text) {
      if (response.streamChunks) {
        const chunks = this.chunkText(response.text, response.chunkSize ?? 10)
        let accumulated = ''
        for (const chunk of chunks) {
          accumulated += chunk
          yield {
            id: createEventId(),
            type: 'assistant_delta',
            createdAt: Date.now(),
            invocationId,
            agentName,
            delta: chunk,
            text: accumulated,
          }
        }
      }
      stepEvents.push({
        id: createEventId(),
        type: 'assistant',
        createdAt,
        invocationId,
        agentName,
        text: response.text,
      } as Event)
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
        }
        stepEvents.push(toolCall)
        toolCalls.push(toolCall)
      }
    }

    return {
      stepEvents,
      toolCalls,
      terminal: toolCalls.length === 0,
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'))
        return
      }
      const timeout = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout)
        reject(new Error('Aborted'))
      })
    })
  }

  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize))
    }
    return chunks
  }
}
