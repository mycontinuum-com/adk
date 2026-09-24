import type { ErrorHandler } from '../errors/types'
import type { Hook } from '../hook/types'
import type { Event, StreamEvent, ToolYieldEvent, AssistantEvent, MediaPart } from './events'
import type { Provider, InvocationContext, Runnable } from './runnables'
import type { ErasedStateSchema, StateSchema, TypedState } from './schema'
import type { Session } from './session'

/**
 * A run in progress. Events are consumed via hooks (onEvent/onStep), not by iterating. This avoids
 * dual-interface complexity and gives one canonical consumption path. abort() propagates through
 * model adapters and terminates the event channel.
 */
export interface StreamResult<T = RunResult> extends AsyncIterable<StreamEvent>, PromiseLike<T> {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent, T>
  /** Fulfills when owned execution and cleanup have finished and ledger events are buffered. */
  readonly settled: Promise<void>
  abort(): void
}

export interface Output<TOutput = unknown> {
  readonly text?: string
  readonly value?: TOutput
  readonly items: readonly AssistantEvent[]
  readonly media?: readonly MediaPart[]
}

export type CommitStatus = 'committed' | 'merged' | 'skipped' | 'orphaned'

export interface RunConfig {
  /** Run-scoped native voice controls, inherited by backend subruns. */
  voice?: InvocationContext['voice']
  timeout?: number
  hooks?: Hook<ErasedStateSchema>[]
  errorHandlers?: ErrorHandler[]
  invocationId?: string
}

export interface InternalRunConfig extends RunConfig {
  onStep?: (stepEvents: Event[], session: Session, runnable: Runnable<ErasedStateSchema>) => void
}

export interface CostEstimate {
  readonly inputCost: number
  readonly outputCost: number
  readonly totalCost: number
  readonly currency: 'USD'
}

/**
 * How a cost figure was obtained. `reported` prices provider-reported usage, or is a charge the
 * provider reported; `estimated` prices locally measured usage; `unavailable` means no figure could
 * be computed and must not read as 0.
 */
export type CostBasis = 'reported' | 'estimated' | 'unavailable'

/** One cost figure with its basis. Unavailable costs carry no amount. */
export type CostAccount =
  | {
      readonly basis: 'reported' | 'estimated'
      readonly totalCost: number
      readonly currency: 'USD'
    }
  | { readonly basis: 'unavailable' }

export interface ModelUsageEntry {
  readonly provider?: Provider
  readonly reportedCostUSD?: number
  readonly modelName: string
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens: number
  readonly audioInputTokens: number
  readonly audioOutputTokens: number
  readonly cost?: CostEstimate
}

export interface UsageSummary {
  readonly reportedCostUSD?: number
  readonly models: readonly ModelUsageEntry[]
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalCachedTokens: number
  readonly totalCacheWriteTokens?: number
  readonly totalReasoningTokens: number
  readonly totalAudioInputTokens: number
  readonly totalAudioOutputTokens: number
  readonly modelCalls: number
  readonly cost?: CostEstimate
}

export interface RunResultBase<S extends StateSchema = StateSchema, TOutput = unknown> {
  readonly runnable: Runnable<ErasedStateSchema>
  readonly session: Session<S>
  readonly state: TypedState<S>
  readonly iterations: number
  readonly usage?: UsageSummary
  readonly output: Output<TOutput>
}

export type TerminationReason = 'maxTurns' | 'maxDuration' | 'stateMatches'

export type RunStatus =
  | 'completed'
  | 'yielded_tool'
  | 'yielded_message'
  | 'error'
  | 'skipped'
  | 'aborted'
  | 'max_steps'
  | 'max_turns'
  | 'max_duration'
  | 'inactivity_timeout'
  | 'disconnected'
  | 'participant_left'
  | 'terminated'
  | 'transferred'

export interface TransferTarget {
  invocationId: string
  agent: Runnable<ErasedStateSchema>
  message?: string
}

export type RunResult<S extends StateSchema = StateSchema, TOutput = unknown> =
  | (RunResultBase<S, TOutput> & { status: 'completed' })
  | (RunResultBase<S, TOutput> & {
      status: 'yielded_tool'
      yieldedTools: ToolYieldEvent[]
    })
  | (RunResultBase<S, TOutput> & {
      status: 'yielded_message'
      yieldedInvocationId: string
    })
  | (RunResultBase<S, TOutput> & { status: 'error'; error: string })
  | (RunResultBase<S, TOutput> & { status: 'skipped' })
  | (RunResultBase<S, TOutput> & { status: 'aborted' })
  | (RunResultBase<S, TOutput> & { status: 'max_steps' })
  | (RunResultBase<S, TOutput> & { status: 'max_turns' })
  | (RunResultBase<S, TOutput> & { status: 'max_duration' })
  | (RunResultBase<S, TOutput> & { status: 'inactivity_timeout' })
  | (RunResultBase<S, TOutput> & { status: 'disconnected' })
  | (RunResultBase<S, TOutput> & { status: 'participant_left' })
  | (RunResultBase<S, TOutput> & {
      status: 'terminated'
      terminationReason: TerminationReason
    })
  | (RunResultBase<S, TOutput> & {
      status: 'transferred'
      transfer: TransferTarget
    })

export type TurnResult = RunResult & {
  sessionId: string
  invocationId: string
  commitStatus?: CommitStatus
}

export interface Runner {
  run(runnable: Runnable<ErasedStateSchema>, session: Session, config?: RunConfig): StreamResult
}
