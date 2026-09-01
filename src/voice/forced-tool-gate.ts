import type { ToolCallEvent, ToolResultEvent } from '../types/events'
import type { ToolChoice } from '../types/runnables'
import type { VoiceEvent, VoiceReply } from './types'

import { createEventId } from '../core/constants'

export type ForcedToolGateSource = 'generate_reply' | 'output_tool_completion'

export interface ForcedToolCallErrorDetails {
  intendedToolName: string
  incorrectToolName?: string
  attempts: number
  maxAttempts: number
  source: ForcedToolGateSource
  reason: 'active_gate' | 'exhausted' | 'timeout' | 'generation_failed'
}

export class ForcedToolCallError extends Error {
  readonly intendedToolName: string
  readonly incorrectToolName?: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly source: ForcedToolGateSource
  readonly reason: ForcedToolCallErrorDetails['reason']
  readonly cause?: unknown

  constructor(details: ForcedToolCallErrorDetails, message?: string, cause?: unknown) {
    super(
      message ??
        `Forced tool call failed: expected '${details.intendedToolName}'` +
          (details.incorrectToolName ? ` but received '${details.incorrectToolName}'` : ''),
    )
    this.name = 'ForcedToolCallError'
    this.intendedToolName = details.intendedToolName
    this.incorrectToolName = details.incorrectToolName
    this.attempts = details.attempts
    this.maxAttempts = details.maxAttempts
    this.source = details.source
    this.reason = details.reason
    this.cause = cause
  }
}

export interface ForcedToolGate {
  forceReply(
    options: VoiceGenerateReplyOptions | undefined,
    trigger: (options: VoiceGenerateReplyOptions | undefined) => Promise<VoiceReply>,
    source?: ForcedToolGateSource,
  ): Promise<VoiceReply>
  interceptToolCall(call: ToolCallEvent): Promise<ForcedToolInterception | undefined>
  handleAssistantMessage(text?: string): Promise<boolean>
  completeToolCall(toolName: string, error?: unknown): void
  waitFor(toolName: string): Promise<void> | undefined
  cancel(toolName?: string): void
}

export interface ForcedToolInterception {
  result: ToolResultEvent
  afterResult?: () => void
}

export type VoiceGenerateReplyOptions = {
  userInput?: string
  instructions?: string
  toolChoice?: ToolChoice
  allowInterruptions?: boolean
}

interface ActiveGate {
  id: string
  intendedToolName: string
  source: ForcedToolGateSource
  startedAt: number
  attempts: number
  maxAttempts: number
  lastIncorrectToolName?: string
  matched: boolean
  timeout: ReturnType<typeof setTimeout>
  retryTimeout?: ReturnType<typeof setTimeout>
  resolve: () => void
  reject: (error: ForcedToolCallError) => void
  promise: Promise<void>
}

interface ForcedToolGateOptions {
  maxAttempts?: number
  timeoutMs?: number
  assistantMessageGraceMs?: number
  noToolRetryMs?: number
  onVoiceEvent?: (event: VoiceEvent) => void
  generateReply: (options: VoiceGenerateReplyOptions) => Promise<VoiceReply>
}

const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_NO_TOOL_RETRY_MS = 5_000

function clearRetry(gate: ActiveGate): void {
  if (!gate.retryTimeout) return
  clearTimeout(gate.retryTimeout)
  gate.retryTimeout = undefined
}

export function createForcedToolGate(options: ForcedToolGateOptions): ForcedToolGate {
  let active: ActiveGate | undefined

  const clear = (gate: ActiveGate) => {
    if (active !== gate) return
    clearTimeout(gate.timeout)
    clearRetry(gate)
    active = undefined
  }

  const fail = (
    gate: ActiveGate,
    reason: ForcedToolCallErrorDetails['reason'],
    cause?: unknown,
  ) => {
    const error =
      cause instanceof ForcedToolCallError
        ? cause
        : new ForcedToolCallError(
            {
              intendedToolName: gate.intendedToolName,
              incorrectToolName: gate.lastIncorrectToolName,
              attempts: gate.attempts,
              maxAttempts: gate.maxAttempts,
              source: gate.source,
              reason,
            },
            undefined,
            cause,
          )
    clear(gate)
    gate.reject(error)
    options.onVoiceEvent?.({
      type: 'forced_tool_failure',
      intendedToolName: gate.intendedToolName,
      incorrectToolName: gate.lastIncorrectToolName,
      attempts: gate.attempts,
      maxAttempts: gate.maxAttempts,
      source: gate.source,
      error,
    })
    return error
  }

  const recordIncorrectTool = (
    gate: ActiveGate,
    incorrectToolName: string,
  ): 'recorded' | 'exhausted' | 'inactive' => {
    if (active !== gate || gate.matched) return 'inactive'
    clearRetry(gate)
    gate.attempts += 1
    gate.lastIncorrectToolName = incorrectToolName

    if (gate.attempts > gate.maxAttempts) {
      fail(gate, 'exhausted')
      return 'exhausted'
    }

    return 'recorded'
  }

  const runCorrection = async (gate: ActiveGate, incorrectToolName: string) => {
    if (active !== gate || gate.matched) return

    const instructions = renderToolCorrectionInstructions({
      incorrectToolName,
      intendedToolName: gate.intendedToolName,
    })
    options.onVoiceEvent?.({
      type: 'forced_tool_correction',
      intendedToolName: gate.intendedToolName,
      incorrectToolName,
      attempts: gate.attempts,
      maxAttempts: gate.maxAttempts,
      source: gate.source,
    })
    try {
      await options.generateReply({
        toolChoice: 'required',
        instructions,
      })
    } catch (err) {
      fail(gate, 'generation_failed', err)
      return
    }
    scheduleNoToolRetry(gate)
  }

  const retry = async (gate: ActiveGate, incorrectToolName: string) => {
    if (recordIncorrectTool(gate, incorrectToolName) !== 'recorded') return
    await runCorrection(gate, incorrectToolName)
  }

  const scheduleNoToolRetry = (gate: ActiveGate) => {
    if (active !== gate || gate.matched) return
    clearRetry(gate)
    gate.retryTimeout = setTimeout(() => {
      void retry(gate, 'no_tool_call')
    }, options.noToolRetryMs ?? DEFAULT_NO_TOOL_RETRY_MS)
  }

  const begin = (intendedToolName: string, source: ForcedToolGateSource): ActiveGate => {
    if (active) {
      throw new ForcedToolCallError(
        {
          intendedToolName,
          incorrectToolName: active.intendedToolName,
          attempts: active.attempts,
          maxAttempts: active.maxAttempts,
          source,
          reason: 'active_gate',
        },
        `Cannot force '${intendedToolName}' while forced tool '${active.intendedToolName}' is pending.`,
      )
    }

    const gate: ActiveGate = {
      id: createEventId(),
      intendedToolName,
      source,
      startedAt: Date.now(),
      attempts: 0,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      matched: false,
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      resolve: () => {},
      reject: () => {},
      promise: Promise.resolve(),
    }
    gate.promise = new Promise<void>((res, rej) => {
      gate.resolve = res
      gate.reject = rej
    })
    gate.promise.catch(() => {})
    gate.timeout = setTimeout(() => {
      if (active === gate) fail(gate, 'timeout')
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    active = gate
    return gate
  }

  return {
    async forceReply(optionsForReply, trigger, source = 'generate_reply') {
      const intendedToolName = getNamedToolChoice(optionsForReply?.toolChoice)
      if (!intendedToolName) return trigger(optionsForReply)

      const gate = begin(intendedToolName, source)
      let reply: VoiceReply
      try {
        reply = await trigger({
          ...optionsForReply,
          toolChoice: 'required',
        })
      } catch (err) {
        throw fail(gate, 'generation_failed', err)
      }
      scheduleNoToolRetry(gate)
      await gate.promise
      return reply
    },

    async interceptToolCall(call) {
      const gate = active
      if (!gate) return undefined
      clearRetry(gate)

      if (call.name === gate.intendedToolName) {
        gate.matched = true
        return undefined
      }

      const status = recordIncorrectTool(gate, call.name)
      if (status === 'inactive') return undefined
      if (active !== gate) {
        return {
          result: makeSyntheticToolResult(
            call,
            undefined,
            `Forced tool call failed: expected '${gate.intendedToolName}' but received '${call.name}'`,
          ),
        }
      }
      return {
        result: makeSyntheticToolResult(call, undefined, undefined),
        afterResult: () => {
          void runCorrection(gate, call.name)
        },
      }
    },

    async handleAssistantMessage() {
      const gate = active
      if (!gate) return false
      if (Date.now() - gate.startedAt < (options.assistantMessageGraceMs ?? 1500)) return false

      await retry(gate, 'spoken_response')
      return true
    },

    completeToolCall(toolName, error) {
      const gate = active
      if (!gate || !gate.matched || gate.intendedToolName !== toolName) return
      if (error) {
        fail(gate, 'generation_failed', error)
        return
      }
      clear(gate)
      gate.resolve()
    },

    waitFor(toolName) {
      const gate = active
      if (!gate || gate.intendedToolName !== toolName) return undefined
      return gate.promise
    },

    cancel(toolName) {
      const gate = active
      if (!gate || (toolName && gate.intendedToolName !== toolName)) return
      clear(gate)
      gate.resolve()
    },
  }
}

export function renderToolCorrectionInstructions(input: {
  incorrectToolName: string
  intendedToolName: string
}): string {
  return `<tool_call_correction>
The previous tool call was incorrect.
Incorrect tool called: ${input.incorrectToolName}
Required tool: ${input.intendedToolName}
Do not call any other tool. Immediately call ${input.intendedToolName} now.
</tool_call_correction>`
}

export function renderToolRequiredInstructions(intendedToolName: string): string {
  return `<tool_call_requirement>
Required tool: ${intendedToolName}
Do not speak to the user. Do not call any other tool. Immediately call ${intendedToolName} now.
</tool_call_requirement>`
}

function getNamedToolChoice(toolChoice: ToolChoice | undefined): string | undefined {
  if (!toolChoice || typeof toolChoice === 'string') return undefined
  return toolChoice.name
}

function makeSyntheticToolResult(
  call: ToolCallEvent,
  result: unknown,
  error: string | undefined,
): ToolResultEvent {
  return {
    id: createEventId(),
    type: 'tool_result',
    createdAt: Date.now(),
    callId: call.callId,
    name: call.name,
    invocationId: call.invocationId,
    agentName: call.agentName,
    durationMs: 0,
    ...(error ? { error } : { result }),
  }
}
