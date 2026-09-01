/**
 * Claude Code Agent
 *
 * Maps @anthropic-ai/claude-agent-sdk to ADK StreamEvents. This is the production agent for
 * integrating Claude Code into the ADK.
 *
 * Features: - Streams SDK messages as ADK StreamEvents - Session resumption for multi-turn
 * conversations - Error handling (rate limit, context window, timeout) - Permission mode support
 * (default: acceptEdits) - Abort signal support - Interactive input via send() - Implements both
 * Runnable (.run()) and Tool (.execute()) interfaces
 *
 * @module
 */

import { randomUUID } from 'node:crypto'

import type { StreamEvent, ToolCallEvent } from '../../../types/events'
import type { FunctionTool, ToolExecutionContext } from '../../../types/runnables'
import type { StateSchema } from '../../../types/schema'
import type {
  CodingAgent,
  CodingTask,
  CodingHandle,
  CodingResult,
  CodingInput,
  CodingToolInput,
  CodingError,
  CodingStatus,
} from '../types'
import type {
  ClaudeCodeOptions,
  ClaudeCodeConfig,
  SDKMessage,
  SDKResultMessage,
  SDKRateLimitEvent,
} from './types'

import { codingToolInputSchema } from '../types'
import {
  MapperContext,
  mapSDKMessage,
  mapResultToCodingResult,
  mapRateLimitEvent,
  createErrorResult,
  extractModifiedFile,
} from './mappers'

/** Interface for the Claude Agent SDK query function. This allows dependency injection for testing. */
export interface ClaudeSDK {
  query(params: { prompt: string; options?: SDKQueryOptions }): AsyncGenerator<SDKMessage>
}

/**
 * Options passed to the SDK query function inside the `options` field. Mirrors the SDK's `Options`
 * type.
 */
export interface SDKQueryOptions {
  cwd?: string
  resume?: string
  sessionId?: string
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  effort?: 'low' | 'medium' | 'high' | 'max'
  thinking?:
    | { type: 'adaptive' }
    | { type: 'enabled'; budgetTokens?: number }
    | { type: 'disabled' }
  systemPrompt?: string
  additionalDirectories?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: string
  includePartialMessages?: boolean
  persistSession?: boolean
  abortController?: AbortController
}

/** Default configuration values. */
const DEFAULT_CONFIG: ClaudeCodeConfig = {
  permissionMode: 'acceptEdits',
  includePartialMessages: true,
  persistSession: true,
}

/** Timeout for SDK operations in milliseconds. */
const SDK_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/** Internal options that include the injected SDK for testing. */
interface InternalClaudeCodeOptions extends ClaudeCodeOptions {
  /** @internal SDK instance for testing - do not use directly */
  _injectedSDK?: ClaudeSDK
}

/**
 * Creates a Claude Code coding agent.
 *
 * @example
 *   ;```typescript
 *   import { claudeCode } from '@animahealth/adk'
 *
 *   const coder = claudeCode({
 *     workspace: '/path/to/repo',
 *     config: {
 *       permissionMode: 'acceptEdits',
 *       maxTurns: 50,
 *     },
 *   })
 *
 *   // Run standalone
 *   const handle = coder.run('Fix the bug in auth.ts')
 *   for await (const event of handle) {
 *     console.log(event.type, event)
 *   }
 *   const result = await handle
 *
 *   // Use as tool in an orchestrator
 *   const orchestrator = app.agent({
 *     tools: [coder],
 *     prompt: 'Delegate coding tasks as needed',
 *   })
 *   ```
 *
 * @param options - Agent options including workspace, config, and API key
 * @returns A CodingAgent that wraps the Claude Agent SDK
 */
export function createClaudeCodeAgent<S extends StateSchema = StateSchema>(
  options: ClaudeCodeOptions,
): CodingAgent<S> {
  const internalOptions = options as InternalClaudeCodeOptions
  const {
    workspace,
    config: userConfig = {},
    provision,
    _injectedSDK: injectedSDK,
  } = internalOptions

  // Merge default config with user config
  const agentConfig: ClaudeCodeConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
  }

  // Lazily load the SDK to avoid import errors when SDK is not installed
  let sdk: ClaudeSDK | null = injectedSDK ?? null

  // SDK module name as a variable to avoid TypeScript trying to resolve it
  const SDK_MODULE = '@anthropic-ai/claude-agent-sdk'

  async function getSDK(): Promise<ClaudeSDK> {
    if (sdk) return sdk

    try {
      // Dynamic import using a variable to prevent TypeScript from resolving types
      const module = await (Function(
        'specifier',
        'return import(specifier)',
      )(SDK_MODULE) as Promise<unknown>)

      // Validate that the module has the expected query method
      if (
        module &&
        typeof module === 'object' &&
        'query' in module &&
        typeof (module as Record<string, unknown>).query === 'function'
      ) {
        sdk = module as ClaudeSDK
        return sdk
      }

      throw new Error('Invalid SDK module: missing query method')
    } catch (error) {
      if (error instanceof Error && error.message.includes('Invalid SDK module')) {
        throw error
      }
      // Not "npm install @anthropic-ai/claude-agent-sdk": the SDK's published versions peer-require
      // zod 4, which npm cannot resolve against this package's zod 3 — that install fails outright.
      // pnpm can hold both, but only when the app pins its own zod, or pnpm links THIS package to
      // the SDK's zod 4 and every schema silently stops working.
      throw new Error(
        'Claude Agent SDK not installed. It requires zod 4, which cannot co-resolve with this ' +
          "package's zod 3 under npm. Install it with pnpm, and pin zod in your own app:\n" +
          '  pnpm add @anthropic-ai/claude-agent-sdk zod@^3.25',
        { cause: error },
      )
    }
  }

  /** Core execution logic shared between run() and execute(). */
  function executeTask(task: string | CodingTask): CodingHandle {
    const taskConfig = typeof task === 'string' ? { task } : task
    const startTime = Date.now()

    // Generate session ID if not provided
    const sessionId = taskConfig.sessionId ?? randomUUID()

    // Create mapper context
    const ctx: MapperContext = {
      invocationId: `inv-${Date.now()}`,
      agentName: 'claude-code',
      processId: `proc-${Date.now()}`,
      accumulatedText: '',
      accumulatedThinking: '',
    }

    // Track state
    let aborted = false
    let resultMessage: SDKResultMessage | null = null
    const modifiedFiles: string[] = []

    // Create abort controller
    const abortController = new AbortController()

    // Handle external abort signal
    taskConfig.signal?.addEventListener('abort', () => {
      aborted = true
      abortController.abort()
    })

    // Create the async generator for streaming events
    async function* generateEvents(): AsyncIterable<StreamEvent> {
      // Run provision function if provided
      if (provision) {
        try {
          await provision(workspace, {
            task: taskConfig.task,
            sessionId: taskConfig.sessionId,
            config: agentConfig,
          })
        } catch (error) {
          // Provision errors are not fatal, but should be logged
          console.warn('Provision function failed:', error)
        }
      }

      // Load SDK
      const claudeSDK: ClaudeSDK = await getSDK()

      const queryOptions: SDKQueryOptions = {
        cwd: workspace,
        permissionMode: agentConfig.permissionMode,
        model: agentConfig.model,
        maxTurns: agentConfig.maxTurns,
        maxBudgetUsd: agentConfig.maxBudgetUsd,
        effort: agentConfig.effort,
        thinking: agentConfig.thinking,
        systemPrompt: agentConfig.systemPrompt,
        additionalDirectories: agentConfig.additionalDirectories,
        allowedTools: agentConfig.allowedTools,
        disallowedTools: agentConfig.disallowedTools,
        includePartialMessages: agentConfig.includePartialMessages,
        persistSession: agentConfig.persistSession,
        abortController,
      }

      if (taskConfig.sessionId) {
        queryOptions.resume = taskConfig.sessionId
      } else {
        queryOptions.sessionId = sessionId
      }

      const timeoutId = setTimeout(() => {
        if (!aborted) {
          aborted = true
          abortController.abort()
        }
      }, SDK_TIMEOUT_MS)

      try {
        const messageStream = claudeSDK.query({
          prompt: taskConfig.task,
          options: queryOptions,
        })

        for await (const message of messageStream) {
          if (aborted) break

          // Handle rate limit events
          if (message.type === 'rate_limit') {
            const rateLimitResult = mapRateLimitEvent(message as SDKRateLimitEvent, ctx)
            if (rateLimitResult.shouldStop) {
              // Store rate limit info for result
              resultMessage = {
                type: 'result',
                subtype: 'error_during_execution',
                total_cost_usd: 0,
                usage: { input_tokens: 0, output_tokens: 0 },
                errors: [
                  {
                    message: `Rate limited. Retry after ${rateLimitResult.retryAfter ?? 'unknown'} seconds.`,
                  },
                ],
                session_id: sessionId,
              } as SDKResultMessage
              break
            }
            continue
          }

          // Handle result messages
          if (message.type === 'result') {
            resultMessage = message as SDKResultMessage
            continue
          }

          // Map SDK message to ADK events
          for (const event of mapSDKMessage(message, ctx)) {
            // Track modified files from tool calls
            if (event.type === 'tool_call') {
              const path = extractModifiedFile(event as ToolCallEvent)
              if (path && !modifiedFiles.includes(path)) {
                modifiedFiles.push(path)
              }
            }

            yield event
          }
        }
      } finally {
        clearTimeout(timeoutId)
      }
    }

    // Track stream completion for deferred result resolution
    let resolveResult: (result: CodingResult) => void
    const resultPromise = new Promise<CodingResult>((resolve, reject) => {
      resolveResult = resolve
      void reject
    })

    // Wrap the generator to track completion and resolve the result
    async function* wrappedStream(): AsyncIterable<StreamEvent> {
      try {
        for await (const event of generateEvents()) {
          yield event
        }

        // Stream completed successfully - resolve the result
        if (aborted && !resultMessage) {
          resolveResult(
            createErrorResult(
              sessionId,
              startTime,
              { message: 'Aborted', code: 'aborted' },
              'aborted',
            ),
          )
        } else if (resultMessage) {
          resolveResult(
            mapResultToCodingResult(
              resultMessage,
              sessionId,
              startTime,
              modifiedFiles,
              ctx.accumulatedText,
            ),
          )
        } else {
          resolveResult(
            createErrorResult(sessionId, startTime, {
              message: 'Unexpected termination',
              code: 'unknown',
            }),
          )
        }
      } catch (error) {
        // Stream errored - resolve with error result
        const errorMessage = error instanceof Error ? error.message : String(error)

        let status: CodingStatus = 'error'
        let errorInfo: CodingError = {
          message: errorMessage,
          code: 'unknown',
        }

        if (errorMessage.toLowerCase().includes('rate limit')) {
          errorInfo.code = 'rate_limited'
          const match = errorMessage.match(/(\d+)\s*second/i)
          if (match) {
            errorInfo.retryAfter = parseInt(match[1], 10)
          }
        } else if (
          errorMessage.toLowerCase().includes('context') ||
          errorMessage.toLowerCase().includes('token limit')
        ) {
          errorInfo.code = 'context_exhausted'
        } else if (errorMessage.toLowerCase().includes('timeout')) {
          status = 'max_duration'
          errorInfo.code = 'timeout'
        } else if (aborted) {
          status = 'aborted'
          errorInfo.code = 'aborted'
        } else {
          errorInfo.code = 'sdk_error'
        }

        resolveResult(createErrorResult(sessionId, startTime, errorInfo, status))
        throw error // Re-throw so caller sees the error
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
          abortController.abort()
          return
        }

        // Note: Interactive input handling (message, tool_response) is deferred to Wave 4.
        console.warn(
          `Claude Code agent: send() with type '${input.type}' not yet supported. Only 'abort' is implemented.`,
        )
      },

      abort(): void {
        aborted = true
        abortController.abort()
      },
    }

    return handle
  }

  // Build the CodingAgent object
  const agent: CodingAgent<S> = {
    name: 'claude-code',
    description:
      'A coding agent powered by Claude Code. Executes coding tasks autonomously with file read/write, shell access, and code understanding.',
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
      // Note: Events are available through the handle's async iterator
      // but FunctionTool.execute doesn't have a streaming mechanism.
      // The caller can use .run() directly if they need event streaming.
      for await (const _ of handle) {
        // Consume events
      }

      return handle.then((result) => result)
    },

    asTool(toolOptions?: {
      name?: string
      description?: string
    }): FunctionTool<CodingToolInput, CodingResult, StreamEvent, S> {
      return {
        name: toolOptions?.name ?? agent.name,
        description: toolOptions?.description ?? agent.description,
        schema: agent.schema,
        execute: agent.execute,
      }
    },
  }

  return agent
}

/**
 * Creates a Claude Code agent with a custom SDK instance. Useful for testing with mock SDKs.
 *
 * @param sdk - Custom SDK instance
 * @param options - Agent options
 * @returns A CodingAgent that uses the provided SDK
 */
export function createClaudeCodeAgentWithSDK<S extends StateSchema = StateSchema>(
  sdk: ClaudeSDK,
  options: ClaudeCodeOptions,
): CodingAgent<S> {
  const internalOptions: InternalClaudeCodeOptions = {
    ...options,
    _injectedSDK: sdk,
  }
  return createClaudeCodeAgent<S>(internalOptions)
}
