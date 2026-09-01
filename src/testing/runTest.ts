import type { StateChanges } from '../session'
import type { Event, StreamEvent } from '../types/events'
import type { Runnable } from '../types/runnables'
import type { RunResult, RunStatus } from '../types/runtime'
import type { StateSchema } from '../types/schema'

import { BaseRunner } from '../core'
import { BaseSession, seedState } from '../session'
import { MockAdapter } from './mock/adapter'
import { isMockAgent, getMockResponses } from './mock/agent'

export interface MockResponseConfig {
  text?: string
  thought?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  error?: Error
  delayMs?: number
  streamChunks?: boolean
  chunkSize?: number
}

export type Step = UserStep | ModelStep | InputStep | ResultStep

export interface UserStep {
  type: 'user'
  text: string
}

export interface ModelStep {
  type: 'model'
  response: MockResponseConfig
}

export interface InputStep {
  type: 'input'
  values: Record<string, unknown | unknown[]>
}

export interface ResultStep {
  type: 'result'
  values: Record<string, unknown | unknown[]>
}

export function user(text: string): UserStep {
  return { type: 'user', text }
}

export function model(response: string | MockResponseConfig): ModelStep {
  // A string means a plain text reply, symmetric with `user(text)`. Before this, a string passed
  // where the config was expected produced a response with no `.text` — the adapter emitted
  // nothing and the run "passed" with the reply silently gone.
  return { type: 'model', response: typeof response === 'string' ? { text: response } : response }
}

export function input(values: Record<string, unknown | unknown[]>): InputStep {
  return { type: 'input', values }
}

export function result(values: Record<string, unknown | unknown[]>): ResultStep {
  return { type: 'result', values }
}

export interface TestOptions {
  initialState?: StateChanges
  schema?: StateSchema
  sessionId?: string
  scopes?: Partial<Record<import('../types').SharedScope, string>>
  timeout?: number
}

export interface TestResult {
  session: BaseSession
  events: readonly Event[]
  streamEvents: StreamEvent[]
  status: RunStatus
  iterations: number
  output?: unknown
  result: RunResult
}

interface ProcessedSteps {
  modelResponses: MockResponseConfig[]
  userMessages: Array<{ text: string; afterYield: boolean }>
  inputValues: Map<number, Record<string, unknown[]>>
  resultValues: Map<number, Record<string, unknown[]>>
}

function processSteps(steps: Step[]): ProcessedSteps {
  const modelResponses: MockResponseConfig[] = []
  const userMessages: Array<{ text: string; afterYield: boolean }> = []
  const inputValues = new Map<number, Record<string, unknown[]>>()
  const resultValues = new Map<number, Record<string, unknown[]>>()

  let modelIndex = -1
  let afterYield = false

  for (const step of steps) {
    switch (step.type) {
      case 'user':
        userMessages.push({ text: step.text, afterYield })
        afterYield = false
        break

      case 'model':
        modelResponses.push(step.response)
        modelIndex++
        if (step.response.toolCalls?.some((tc) => tc)) {
          afterYield = true
        }
        break

      case 'input': {
        const normalized: Record<string, unknown[]> = {}
        for (const [name, val] of Object.entries(step.values)) {
          normalized[name] = Array.isArray(val) ? val : [val]
        }
        const existing = inputValues.get(modelIndex) ?? {}
        for (const [name, vals] of Object.entries(normalized)) {
          existing[name] = [...(existing[name] ?? []), ...vals]
        }
        inputValues.set(modelIndex, existing)
        break
      }

      case 'result': {
        const normalized: Record<string, unknown[]> = {}
        for (const [name, val] of Object.entries(step.values)) {
          normalized[name] = Array.isArray(val) ? val : [val]
        }
        const existing = resultValues.get(modelIndex) ?? {}
        for (const [name, vals] of Object.entries(normalized)) {
          existing[name] = [...(existing[name] ?? []), ...vals]
        }
        resultValues.set(modelIndex, existing)
        break
      }
    }
  }

  return { modelResponses, userMessages, inputValues, resultValues }
}

function collectMockResponses(runnable: Runnable): MockResponseConfig[] {
  if (runnable.kind === 'agent' && isMockAgent(runnable)) {
    return getMockResponses(runnable)
  }
  if (runnable.kind === 'sequence' || runnable.kind === 'parallel') {
    return runnable.runnables.flatMap(collectMockResponses)
  }
  if (runnable.kind === 'loop') {
    return collectMockResponses(runnable.runnable)
  }
  return []
}

export async function runTest(
  runnable: Runnable,
  steps: Step[],
  options?: TestOptions,
): Promise<TestResult> {
  const processed = processSteps(steps)
  const mockAgentResponses = collectMockResponses(runnable)
  const allResponses = [...mockAgentResponses, ...processed.modelResponses]
  const adapter = new MockAdapter({ responses: allResponses })

  const runner = new BaseRunner({
    adapters: { openai: adapter, gemini: adapter },
  })

  const session = new BaseSession('test-app', {
    id: options?.sessionId ?? `test-${Date.now()}`,
    scopes: options?.scopes,
  })

  if (options?.initialState) {
    seedState(session, options.initialState, options.schema)
  }

  const allStreamEvents: StreamEvent[] = []
  let messageIndex = 0
  let modelResponseIndex = -1
  const inputCounters = new Map<string, number>()
  const resultCounters = new Map<string, number>()

  const runOnce = async (): Promise<RunResult> => {
    modelResponseIndex++
    const events: StreamEvent[] = []
    const stream = runner.run(runnable, session, {
      timeout: options?.timeout,
      hooks: [{ onEvent: (event: StreamEvent) => events.push(event) }],
    })
    const runResult = await stream
    allStreamEvents.push(...events)
    return runResult
  }

  if (
    processed.userMessages.length > 0 &&
    processed.userMessages[0] &&
    !processed.userMessages[0].afterYield
  ) {
    session.input.message(processed.userMessages[0].text)
    messageIndex = 1
  }

  let runLoopResult = await runOnce()

  while (runLoopResult.status === 'yielded_tool' || runLoopResult.status === 'yielded_message') {
    if (runLoopResult.status === 'yielded_tool') {
      const yieldedTools = runLoopResult.yieldedTools
      const currentInputs = processed.inputValues.get(modelResponseIndex) ?? {}
      const currentResults = processed.resultValues.get(modelResponseIndex) ?? {}

      for (const call of yieldedTools) {
        const toolInputs = currentInputs[call.name]
        if (toolInputs) {
          const inputIndex = inputCounters.get(call.name) ?? 0
          if (inputIndex < toolInputs.length) {
            session.input.tool({
              callId: call.callId,
              input: toolInputs[inputIndex],
            })
            inputCounters.set(call.name, inputIndex + 1)
          }
        }

        const toolResults = currentResults[call.name]
        if (toolResults) {
          const resultIndex = resultCounters.get(call.name) ?? 0
          if (resultIndex < toolResults.length) {
            const mockResult = toolResults[resultIndex]
            session.input.tool({ callId: call.callId, input: mockResult })
            resultCounters.set(call.name, resultIndex + 1)
          }
        }
      }
    } else {
      const nextMessage = processed.userMessages[messageIndex]
      if (nextMessage) {
        session.input.message({
          text: nextMessage.text,
          invocationId: runLoopResult.yieldedInvocationId,
        })
        messageIndex++
      } else {
        break
      }
    }

    if (session.yieldedTools.length > 0) break
    runLoopResult = await runOnce()
  }

  return {
    session,
    events: session.events,
    streamEvents: allStreamEvents,
    status: runLoopResult.status,
    iterations: runLoopResult.iterations,
    output: runLoopResult.output.value,
    result: runLoopResult,
  }
}
