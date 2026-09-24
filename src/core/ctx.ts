import type { EventChannel } from '../channels'
import type {
  InvocationContext,
  ToolContext,
  ToolCallEvent,
  SessionService,
  Runnable,
  SubRunner,
  Session,
} from '../types'
import type { StateSchema } from '../types/schema'

import { createStateAccessor } from '../context'
import { createOrchestrationContext } from './orchestration'
import { signalOutput, signalEnd } from './tools'

export function createInvocationContext<S extends StateSchema = StateSchema>(
  session: Session,
  sessionService: SessionService,
  invocationId: string,
  runnable: Runnable<S>,
  parentInvocationId?: string,
  subRunner?: SubRunner,
  signal?: AbortSignal,
  channel?: EventChannel,
  voice?: InvocationContext<S>['voice'],
): InvocationContext<S> {
  const orchestration = createOrchestrationContext<S>({
    session,
    sessionService,
    invocationId,
    subRunner,
    signal,
    channel,
  })

  return {
    invocationId,
    parentInvocationId,
    runnable,
    session: session as unknown as Session<S>,
    state: createStateAccessor<S>(session, invocationId),
    sessionService,
    signal,
    endInvocation: false,
    voice,
    ...orchestration,
  }
}

export function createToolContext<S extends StateSchema = StateSchema>(
  invocationCtx: InvocationContext<S>,
  call: ToolCallEvent,
  session: Session,
  sessionService: SessionService,
  subRunner?: SubRunner,
  signal?: AbortSignal,
  channel?: EventChannel,
): ToolContext<S> {
  const orchestration = createOrchestrationContext<S>({
    session,
    sessionService,
    invocationId: invocationCtx.invocationId,
    subRunner,
    signal,
    callId: call.callId,
    channel,
  })

  return {
    ...invocationCtx,
    state: createStateAccessor<S>(session, invocationCtx.invocationId),
    callId: call.callId,
    toolName: call.name,
    args: call.args,
    subRunner: subRunner as SubRunner<S> | undefined,
    signal,
    output: (value: unknown) => signalOutput(value),
    end: () => signalEnd(),
    ...orchestration,
  }
}
