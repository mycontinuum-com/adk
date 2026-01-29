import type { Event, StreamEvent, ToolCallEvent, ModelUsage } from './events';
import type { Session } from './session';
import type { Runnable } from './runnables';
import type { User } from './user';

export interface StreamResult<T = RunResult>
  extends AsyncIterable<StreamEvent>,
    PromiseLike<T> {
  abort(): void;
}

export interface RunConfig {
  timeout?: number;
  onStep?: (stepEvents: Event[], session: Session, runnable: Runnable) => void;
  onStream?: (event: StreamEvent) => void;
  user?: User;
  maxYieldIterations?: number;
}

export interface CostEstimate {
  readonly inputCost: number;
  readonly outputCost: number;
  readonly totalCost: number;
  readonly currency: 'USD';
}

export interface UsageSummary {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedTokens: number;
  readonly totalReasoningTokens: number;
  readonly modelCalls: number;
  readonly cost?: CostEstimate;
}

export interface RunResultBase {
  readonly runnable: Runnable;
  readonly session: Session;
  readonly iterations: number;
  readonly stepEvents: readonly Event[];
  readonly usage?: UsageSummary;
}

export type RunStatus =
  | 'completed'
  | 'yielded'
  | 'error'
  | 'aborted'
  | 'max_steps'
  | 'transferred';

export interface TransferTarget {
  invocationId: string;
  agent: Runnable;
  message?: string;
}

export type RunResult<TOutput = unknown> =
  | (RunResultBase & { status: 'completed'; output?: TOutput })
  | (RunResultBase & {
      status: 'yielded';
      pendingCalls: ToolCallEvent[];
      awaitingInput?: boolean;
      yieldedInvocationId?: string;
    })
  | (RunResultBase & { status: 'error'; error: string })
  | (RunResultBase & { status: 'aborted' })
  | (RunResultBase & { status: 'max_steps' })
  | (RunResultBase & { status: 'transferred'; transfer: TransferTarget });

export interface Runner {
  run(runnable: Runnable, session: Session, config?: RunConfig): StreamResult;
}
