import { randomUUID } from 'node:crypto';
import type {
  Runnable,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
  InvocationEndReason,
  HandoffTarget,
  HandoffOrigin,
  Session,
  SessionService,
  StreamEvent,
} from '../types';
import { createEventId } from '../session';
import { INVOCATION_ID_PREFIX, INVOCATION_ID_LENGTH } from './constants';

export interface YieldInfo {
  pendingCallIds: string[];
  yieldIndex: number;
  awaitingInput?: boolean;
}

export interface InvocationBoundaryOptions<T> {
  onStream?: (event: StreamEvent) => void;
  getIterations?: (result: T) => number;
  getEndReason?: (result: T) => InvocationEndReason;
  getError?: (result: T) => string | undefined;
  getHandoffTarget?: (result: T) => HandoffTarget | undefined;
  isYielded?: (result: T) => boolean;
  getYieldInfo?: (result: T) => YieldInfo;
  handoffOrigin?: HandoffOrigin;
  managed?: boolean;
  fingerprint?: string;
}

export interface ResumeContext {
  invocationId: string;
  yieldIndex: number;
}

export async function* withInvocationBoundary<T>(
  runnable: Runnable,
  invocationId: string,
  parentInvocationId: string | undefined,
  session: Session,
  sessionService: SessionService,
  generator: AsyncGenerator<StreamEvent, T>,
  options?: InvocationBoundaryOptions<T>,
  resumeContext?: ResumeContext,
): AsyncGenerator<StreamEvent, T> {
  if (options?.managed) {
    let iterResult = await generator.next();
    while (!iterResult.done) {
      yield iterResult.value;
      iterResult = await generator.next();
    }
    return iterResult.value;
  }

  if (resumeContext && resumeContext.yieldIndex >= 0) {
    const resumeEvent: InvocationResumeEvent = {
      id: createEventId(),
      type: 'invocation_resume',
      createdAt: Date.now(),
      invocationId: resumeContext.invocationId,
      agentName: runnable.name,
      parentInvocationId,
      yieldIndex: resumeContext.yieldIndex,
    };
    await sessionService.appendEvent(session, resumeEvent);
    options?.onStream?.(resumeEvent);
    yield resumeEvent;
  } else {
    const isRootInvocation = !parentInvocationId;
    const startEvent: InvocationStartEvent = {
      id: createEventId(),
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: resumeContext?.invocationId ?? invocationId,
      agentName: runnable.name,
      parentInvocationId,
      kind: runnable.kind,
      handoffOrigin: options?.handoffOrigin,
      fingerprint: isRootInvocation ? options?.fingerprint : undefined,
      version: isRootInvocation ? session.version : undefined,
    };
    await sessionService.appendEvent(session, startEvent);
    options?.onStream?.(startEvent);
    yield startEvent;
  }

  const effectiveInvocationId = resumeContext?.invocationId ?? invocationId;
  let endReason: InvocationEndReason = 'completed';
  let endError: string | undefined;
  let result: T | undefined;

  const emitEndEvent = async function* (): AsyncGenerator<
    InvocationEndEvent,
    void
  > {
    const iterations =
      result && options?.getIterations
        ? options.getIterations(result)
        : undefined;
    const handoffTarget =
      result && options?.getHandoffTarget
        ? options.getHandoffTarget(result)
        : undefined;

    const endEvent: InvocationEndEvent = {
      id: createEventId(),
      type: 'invocation_end',
      createdAt: Date.now(),
      invocationId: effectiveInvocationId,
      agentName: runnable.name,
      parentInvocationId,
      reason: endReason,
      iterations,
      error: endError,
      handoffTarget,
    };
    await sessionService.appendEvent(session, endEvent);
    options?.onStream?.(endEvent);
    yield endEvent;
  };

  const emitYieldEvent = async function* (
    yieldInfo: YieldInfo,
  ): AsyncGenerator<InvocationYieldEvent, void> {
    const yieldEvent: InvocationYieldEvent = {
      id: createEventId(),
      type: 'invocation_yield',
      createdAt: Date.now(),
      invocationId: effectiveInvocationId,
      agentName: runnable.name,
      parentInvocationId,
      pendingCallIds: yieldInfo.pendingCallIds,
      yieldIndex: yieldInfo.yieldIndex,
      awaitingInput: yieldInfo.awaitingInput,
    };
    await sessionService.appendEvent(session, yieldEvent);
    options?.onStream?.(yieldEvent);
    yield yieldEvent;
  };

  try {
    let iterResult = await generator.next();
    while (!iterResult.done) {
      yield iterResult.value;
      iterResult = await generator.next();
    }
    result = iterResult.value;

    const isYielded = options?.isYielded?.(result) ?? false;
    if (isYielded && options?.getYieldInfo) {
      const yieldInfo = options.getYieldInfo(result);
      yield* emitYieldEvent(yieldInfo);
    } else {
      endReason = options?.getEndReason?.(result) ?? 'completed';
      endError = options?.getError?.(result);
      yield* emitEndEvent();
    }
  } catch (error) {
    endReason = 'error';
    endError = error instanceof Error ? error.message : String(error);
    yield* emitEndEvent();
    throw error;
  }

  return result as T;
}

export function createInvocationId(): string {
  return `${INVOCATION_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, INVOCATION_ID_LENGTH)}`;
}
