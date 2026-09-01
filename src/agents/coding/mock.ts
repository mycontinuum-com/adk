/**
 * Mock Coding Agent
 *
 * A deterministic coding agent for testing and CI. Emits predefined responses and artifacts without
 * making any LLM API calls.
 *
 * Features: - Zero token cost integration testing - Predictable stream events - Configurable delays
 * for realistic streaming simulation - Error simulation for testing error handling - Implements
 * CodingAgent interface (both .run() and .execute())
 *
 * @module
 */

import type {
  StreamEvent,
  AssistantEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  ThoughtEvent,
  ArtifactUpdateEvent,
} from '../../types/events'
import type { FunctionTool, ToolExecutionContext } from '../../types/runnables'
import type { StateSchema } from '../../types/schema'
import type {
  CodingAgent,
  CodingTask,
  CodingHandle,
  CodingResult,
  CodingInput,
  CodingToolInput,
  CodingOutput,
  MockCodingAgentOptions,
  MockResponse,
  MockArtifact,
} from './types'

import { codingToolInputSchema } from './types'

/** Creates a unique ID for events. */
function createEventId(): string {
  return `mock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Creates a unique call ID for tool calls. */
function createCallId(): string {
  return `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Converts a MockResponse to a StreamEvent. */
function responseToEvent(
  response: MockResponse,
  invocationId: string,
  agentName: string,
): StreamEvent {
  const base = {
    id: createEventId(),
    createdAt: Date.now(),
    invocationId,
    agentName,
  }

  switch (response.type) {
    case 'assistant':
      return {
        ...base,
        type: 'assistant',
        text: response.text ?? '',
      } as AssistantEvent

    case 'assistant_delta':
      return {
        ...base,
        type: 'assistant_delta',
        delta: response.text ?? '',
        text: response.text ?? '',
      } as AssistantDeltaEvent

    case 'thought':
      return {
        ...base,
        type: 'thought',
        text: response.text ?? '',
      } as ThoughtEvent

    case 'tool_call':
      return {
        ...base,
        type: 'tool_call',
        callId: response.callId ?? createCallId(),
        name: response.name ?? 'unknown',
        args: response.args ?? {},
      } as ToolCallEvent

    case 'tool_result':
      return {
        ...base,
        type: 'tool_result',
        callId: response.callId ?? createCallId(),
        name: response.name ?? 'unknown',
        result: response.result,
        error: response.error,
      } as ToolResultEvent

    default:
      throw new Error(`Unknown mock response type: ${(response as MockResponse).type}`)
  }
}

/** Converts a MockArtifact to an ArtifactUpdateEvent. */
function artifactToEvent(
  artifact: MockArtifact,
  processId: string,
  version: number,
  invocationId: string,
  agentName: string,
): ArtifactUpdateEvent {
  return {
    id: createEventId(),
    type: 'artifact_update',
    createdAt: Date.now(),
    name: artifact.name,
    version,
    mimeType: artifact.mimeType ?? inferMimeType(artifact.content),
    processId,
    invocationId,
    agentName,
  }
}

/** Infer MIME type from content. */
function inferMimeType(content: string | Buffer): string {
  if (Buffer.isBuffer(content)) {
    return 'application/octet-stream'
  }
  const trimmed = content.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'application/json'
    } catch {
      // Not valid JSON
    }
  }
  if (trimmed.startsWith('#') || /\n#{1,6}\s/.test(content)) {
    return 'text/markdown'
  }
  return 'text/plain'
}

/** Sleep helper for delays. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Creates a mock coding agent.
 *
 * @example
 *   ;```typescript
 *   import { coding } from '@animahealth/adk'
 *
 *   const coder = coding.mock({
 *     responses: [
 *       { type: 'assistant', text: 'Creating file...' },
 *       { type: 'tool_call', name: 'write', args: { path: 'test.txt', content: 'hello' } },
 *       { type: 'tool_result', name: 'write', result: 'File written successfully' },
 *     ],
 *     artifacts: [{ name: 'summary', content: '# Summary\nTask completed.' }],
 *   })
 *
 *   // Run standalone
 *   const handle = coder.run('Create test.txt')
 *   for await (const event of handle) {
 *     console.log(event.type, event)
 *   }
 *   const result = await handle
 *   console.log(result.status) // 'completed'
 *
 *   // Use as tool
 *   const orchestrator = app.agent({ tools: [coder] })
 *   ```
 *
 * @param options - Configuration for mock behavior
 * @returns A CodingAgent that emits predefined events
 */
export function createMockCodingAgent<S extends StateSchema = StateSchema>(
  options: MockCodingAgentOptions = {},
): CodingAgent<S> {
  const {
    responses = [],
    artifacts = [],
    result: customResult,
    delayMs = 0,
    simulateError,
  } = options

  /** Core execution logic. */
  function executeTask(task: string | CodingTask): CodingHandle {
    const taskConfig = typeof task === 'string' ? { task } : task
    const startTime = Date.now()

    const sessionId = taskConfig.sessionId ?? `mock-session-${Date.now()}`
    const processId = `mock-process-${Date.now()}`
    const invocationId = `mock-invocation-${Date.now()}`
    const agentName = 'mock-coding-agent'

    let aborted = false
    let accumulatedText = ''

    // Handle abort signal from config
    taskConfig.signal?.addEventListener('abort', () => {
      aborted = true
    })

    // Create the async generator for streaming events
    async function* generateEvents(): AsyncIterable<StreamEvent> {
      // Check for immediate error
      if (simulateError?.after === 'immediately') {
        throw new Error(simulateError.message)
      }

      let eventIndex = 0

      // Emit responses
      for (const response of responses) {
        if (aborted) break

        // Check for error after N events
        if (typeof simulateError?.after === 'number' && eventIndex >= simulateError.after) {
          throw new Error(simulateError.message)
        }

        if (delayMs > 0) {
          await sleep(delayMs)
        }

        const event = responseToEvent(response, invocationId, agentName)

        // Track accumulated text for output
        if (event.type === 'assistant') {
          accumulatedText += (event as AssistantEvent).text
        }

        yield event
        eventIndex++
      }

      // Emit artifact updates
      let artifactVersion = 0
      for (const artifact of artifacts) {
        if (aborted) break

        if (delayMs > 0) {
          await sleep(delayMs)
        }

        yield artifactToEvent(artifact, processId, artifactVersion++, invocationId, agentName)
      }
    }

    // Track stream completion for deferred result resolution
    let resolveResult: (result: CodingResult) => void
    const resultPromise = new Promise<CodingResult>((resolve) => {
      resolveResult = resolve
    })

    // Wrap the generator to track completion and resolve the result
    async function* wrappedStream(): AsyncIterable<StreamEvent> {
      try {
        const events: StreamEvent[] = []
        for await (const event of generateEvents()) {
          events.push(event)
          yield event
        }

        // Determine modified files from tool calls
        const modifiedFiles: string[] = []
        for (const event of events) {
          if (event.type === 'tool_call') {
            const args = event.args as Record<string, unknown>
            const path = args.path ?? args.file_path ?? args.filePath
            if (path && typeof path === 'string') {
              if (!modifiedFiles.includes(path)) {
                modifiedFiles.push(path)
              }
            }
          }
        }

        const durationMs = Date.now() - startTime

        // Build output
        const outputValue: CodingOutput = {
          modifiedFiles,
        }

        resolveResult({
          status: aborted ? 'aborted' : 'completed',
          sessionId,
          durationMs,
          output: {
            text: accumulatedText || undefined,
            value: outputValue,
            items: [],
          },
          usage: {
            models: [],
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedTokens: 0,
            totalReasoningTokens: 0,
            totalAudioInputTokens: 0,
            totalAudioOutputTokens: 0,
            modelCalls: 0,
          },
          ...customResult,
        })
      } catch (error) {
        const durationMs = Date.now() - startTime
        resolveResult({
          status: 'error',
          sessionId,
          durationMs,
          output: {
            text: undefined,
            value: { modifiedFiles: [] },
            items: [],
          },
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: simulateError?.code ?? 'unknown',
          },
          ...customResult,
        })
        throw error
      }
    }

    const sharedStream = wrappedStream()

    // Create iterator that can be reused
    let iterator: AsyncIterator<StreamEvent, CodingResult> | null = null

    const handle: CodingHandle = {
      [Symbol.asyncIterator]() {
        if (!iterator) {
          iterator = sharedStream[Symbol.asyncIterator]()
        }
        return iterator
      },

      // oxlint-disable-next-line eslint-plugin-unicorn(no-thenable)
      then<TResult1 = CodingResult, TResult2 = never>(
        onfulfilled?: ((value: CodingResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        // Consume the stream to completion to ensure result resolves
        ;(async () => {
          try {
            for await (const _ of handle) {
              // Consume events
            }
          } catch {
            // Errors are handled in wrappedStream
          }
        })()
        return resultPromise.then(onfulfilled, onrejected)
      },

      send(input: CodingInput): void {
        if (input.type === 'abort') {
          aborted = true
        }
      },

      abort(): void {
        aborted = true
      },
    }

    return handle
  }

  // Build the CodingAgent object
  const agent: CodingAgent<S> = {
    name: 'mock',
    description: 'A mock coding agent for testing. Emits predefined responses.',
    schema: codingToolInputSchema,

    run(task: string | CodingTask): CodingHandle {
      return executeTask(task)
    },

    async execute(
      ctx: ToolExecutionContext<CodingToolInput, StreamEvent, unknown, S>,
    ): Promise<CodingResult> {
      const handle = executeTask({
        task: ctx.args.task,
        sessionId: ctx.args.sessionId,
        signal: ctx.signal,
      })

      // Consume the stream to completion
      for await (const _ of handle) {
        // Consume events
      }

      return handle.then((result) => result)
    },

    asTool(opts?: {
      name?: string
      description?: string
    }): FunctionTool<CodingToolInput, CodingResult, StreamEvent, S> {
      return {
        name: opts?.name ?? agent.name,
        description: opts?.description ?? agent.description,
        schema: agent.schema,
        execute: agent.execute,
      }
    },
  }

  return agent
}
