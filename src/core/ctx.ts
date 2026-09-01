import type { EventChannel } from '../channels'
import type {
  InvocationContext,
  ToolContext,
  ToolCallEvent,
  StreamEvent,
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
  onStream?: (e: StreamEvent) => void,
  signal?: AbortSignal,
  channel?: EventChannel,
): InvocationContext<S> {
  const orchestration = createOrchestrationContext<S>({
    session,
    sessionService,
    invocationId,
    subRunner,
    onStream,
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
    onStream,
    endInvocation: false,
    ...orchestration,
  }
}

export function createToolContext<S extends StateSchema = StateSchema>(
  invocationCtx: InvocationContext<S>,
  call: ToolCallEvent,
  session: Session,
  sessionService: SessionService,
  subRunner?: SubRunner,
  onStream?: (e: StreamEvent) => void,
  signal?: AbortSignal,
  channel?: EventChannel,
): ToolContext<S> {
  const orchestration = createOrchestrationContext<S>({
    session,
    sessionService,
    invocationId: invocationCtx.invocationId,
    subRunner,
    onStream,
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
    onStream,
    signal,
    output: (value: unknown) => signalOutput(value),
    end: () => signalEnd(),
    ...orchestration,
  }
}
