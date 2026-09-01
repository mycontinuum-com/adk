/**
 * Coding Agent Types
 *
 * Defines the interface for coding agents that integrate external coding tools (Claude Code, Codex,
 * etc.) into the ADK execution pipeline.
 *
 * Design principles: - Coding agents are full agents, not adapters - they execute autonomously -
 * CodingAgent implements both Runnable (.run()) and Tool (.execute()) interfaces - CodingResult
 * aligns with ADK's RunResult structure - CodingHandle extends PromiseLike for ergonomic await
 *
 * @module
 */

import { z } from 'zod'

import type { StreamEvent } from '../../types/events'
import type { FunctionTool, ToolExecutionContext } from '../../types/runnables'
import type { UsageSummary, Output } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'

// ============================================================================
// Task Configuration
// ============================================================================

/** Task configuration for a coding agent run. */
export interface CodingTask {
  /** The task description/prompt for the coding agent. */
  task: string

  /**
   * Session ID for resumption. When provided, the agent resumes from the previous session state.
   * When omitted, starts a new session.
   */
  sessionId?: string

  /** Abort signal for cancellation. */
  signal?: AbortSignal
}

/** Tool input schema for when coding agent is used as a tool. */
export interface CodingToolInput {
  /** The task description/prompt. */
  task: string

  /** Optional session ID for resumption. */
  sessionId?: string
}

/** Zod schema for CodingToolInput validation. */
export const codingToolInputSchema = z.object({
  task: z.string().describe('The task description for the coding agent'),
  sessionId: z.string().optional().describe('Session ID for resuming a previous session'),
})

// ============================================================================
// Result Types
// ============================================================================

/** Error codes specific to coding agent failures. */
export type CodingErrorCode =
  | 'rate_limited' // Hit API rate limit, check retryAfter
  | 'context_exhausted' // Context window full
  | 'sdk_error' // SDK threw an error
  | 'aborted' // User/signal aborted
  | 'timeout' // Exceeded time limit
  | 'unknown' // Unexpected error

/** Structured error information from coding agents. */
export interface CodingError {
  /** Human-readable error message. */
  message: string

  /** Machine-readable error code for programmatic handling. */
  code: CodingErrorCode

  /** Seconds to wait before retry (for rate_limited errors). */
  retryAfter?: number
}

/** Structured output value from coding agents. */
export interface CodingOutput {
  /** Files modified during execution. */
  modifiedFiles: string[]

  /** Additional provider-specific metadata. */
  metadata?: Record<string, unknown>
}

/** Status of a coding agent run. Subset of ADK's RunStatus relevant to coding agents. */
export type CodingStatus =
  | 'completed' // Agent finished the task successfully
  | 'error' // Agent encountered an error
  | 'aborted' // Execution was aborted via signal
  | 'max_turns' // Exceeded maximum turns
  | 'max_duration' // Exceeded time limit

/** Result of a coding agent run. Aligned with ADK's RunResult structure. */
export interface CodingResult {
  /** Execution status. */
  status: CodingStatus

  /** Session ID for resuming the conversation. */
  sessionId: string

  /**
   * Output from the agent. - output.text: Final assistant message - output.value: Structured
   * CodingOutput with modifiedFiles
   */
  output: Output<CodingOutput>

  /** Usage statistics - uses ADK's UsageSummary format. */
  usage?: UsageSummary

  /** Error details when status is 'error'. */
  error?: CodingError

  /** Execution duration in milliseconds. */
  durationMs?: number
}

// ============================================================================
// Handle & Input Types
// ============================================================================

/** Input that can be sent to a running coding agent. */
export type CodingInput =
  | { type: 'message'; text: string }
  | { type: 'tool_response'; callId: string; approved: boolean }
  | { type: 'abort' }

/**
 * Handle to a running coding agent. Extends AsyncIterable and PromiseLike for ergonomic usage.
 *
 * @example
 *   ;```typescript
 *   const handle = coder.run('Fix the bug')
 *
 *   // Stream events
 *   for await (const event of handle) {
 *     console.log(event)
 *   }
 *
 *   // Or just await the result
 *   const result = await handle
 *   ```
 */
export interface CodingHandle extends AsyncIterable<StreamEvent>, PromiseLike<CodingResult> {
  /**
   * Send input to the agent during execution. Used for interactive scenarios (permission prompts,
   * follow-up questions).
   */
  send(input: CodingInput): void

  /** Abort the execution. */
  abort(): void
}

// ============================================================================
// Coding Agent Interface
// ============================================================================

/** Configuration options for customizing the tool form of a coding agent. */
export interface CodingToolOptions {
  /** Override the tool name (default: agent.name). */
  name?: string

  /** Override the tool description. */
  description?: string
}

/**
 * A coding agent that can run standalone or as a tool.
 *
 * Implements both: - Runnable semantics via .run() for standalone execution and sequences -
 * FunctionTool interface via .execute() for use in agent tool arrays
 *
 * @example
 *   ;```typescript
 *   import { claudeCode } from '@animahealth/adk'
 *
 *   const coder = claudeCode({ workspace: '/repo' })
 *
 *   // Run standalone
 *   const handle = coder.run('Fix the bug')
 *   const result = await handle
 *
 *   // Use as tool (implements FunctionTool)
 *   const orchestrator = app.agent({
 *     tools: [coder],
 *     prompt: 'Delegate coding tasks as needed',
 *   })
 *
 *   // Use in a sequence
 *   app.run(app.sequence({ agents: [planner, coder, reviewer] }), input)
 *   ```
 */
export interface CodingAgent<S extends StateSchema = StateSchema> extends FunctionTool<
  CodingToolInput,
  CodingResult,
  StreamEvent,
  S
> {
  /** Agent name (e.g., 'claude-code'). */
  name: string

  /** Description for when used as a tool. */
  description: string

  /** Zod schema for tool input validation. */
  schema: z.ZodType<CodingToolInput>

  /**
   * Run the coding agent.
   *
   * @example
   *   ;```typescript
   *   // Simple string task
   *   const handle = coder.run('Fix the authentication bug')
   *
   *   // With options
   *   const handle = coder.run({
   *     task: 'Refactor the payment module',
   *     sessionId: 'resume-abc123',
   *   })
   *   ```
   *
   * @param task - Task string or full configuration
   * @returns Handle with stream, result, send, abort
   */
  run(task: string | CodingTask): CodingHandle

  /** Execute as a tool (FunctionTool interface). Called by ADK when the agent is in a tools array. */
  execute(
    ctx: ToolExecutionContext<CodingToolInput, StreamEvent, unknown, S>,
  ): Promise<CodingResult>

  /**
   * Create a customized tool form of this agent. Only needed when overriding name, description, or
   * schema.
   *
   * @example
   *   ;```typescript
   *   const tool = coder.asTool({
   *     name: 'delegate_coding',
   *     description: 'Use for complex refactoring only',
   *   })
   *   ```
   */
  asTool(options?: CodingToolOptions): FunctionTool<CodingToolInput, CodingResult, StreamEvent, S>
}

// ============================================================================
// Mock Types (for testing)
// ============================================================================

/** Mock response for testing. */
export interface MockResponse {
  /** Type of response to emit. */
  type: 'assistant' | 'assistant_delta' | 'tool_call' | 'tool_result' | 'thought'

  /** Text content (for assistant, assistant_delta, thought). */
  text?: string

  /** Tool call details (for tool_call). */
  name?: string
  args?: Record<string, unknown>
  callId?: string

  /** Tool result details (for tool_result). */
  result?: unknown
  error?: string
}

/** Mock artifact for testing. */
export interface MockArtifact {
  /** Artifact name. */
  name: string

  /** Artifact content. */
  content: string | Buffer

  /** MIME type. */
  mimeType?: string
}

/** Options for creating a mock coding agent. */
export interface MockCodingAgentOptions {
  /** Predefined responses to emit during execution. Each response is converted to a StreamEvent. */
  responses?: MockResponse[]

  /** Predefined artifacts to "create" during execution. Emits artifact_update events. */
  artifacts?: MockArtifact[]

  /**
   * Simulated result when execution completes. Defaults to { status: 'completed', sessionId:
   * 'mock-session' }.
   */
  result?: Partial<CodingResult>

  /**
   * Delay between events in milliseconds. Simulates realistic streaming behavior. Defaults to 0
   * (immediate).
   */
  delayMs?: number

  /** If provided, simulate an error during execution. */
  simulateError?: {
    /** When to throw (after N events, or 'immediately'). */
    after?: number | 'immediately'
    /** Error message. */
    message: string
    /** Error code. */
    code?: CodingErrorCode
  }
}
