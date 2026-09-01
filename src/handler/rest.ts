import type { StreamEvent, Event } from '../types/events'
import type { RunResult, RunStatus, Output, TurnResult, UsageSummary } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { HandlerInput, HandlerConfig } from './types'

import { turn } from './turn'

export interface RestResponse {
  sessionId: string
  status: RunStatus
  output: Output
  yieldedTools?: Array<{
    callId: string
    name: string
    args: unknown
  }>
  state?: Record<string, unknown>
  events?: Event[]
  usage?: UsageSummary
  error?: string
  warning?: string
}

export function restHandler<S extends StateSchema>(
  config: HandlerConfig<S>,
): (input: HandlerInput) => Promise<RestResponse> {
  const responseConfig = config.response ?? {}

  return async (input: HandlerInput): Promise<RestResponse> => {
    const turnStream = turn(config, input)
    const streamEvents: StreamEvent[] = []

    const it = turnStream[Symbol.asyncIterator]()
    let iterResult = await it.next()
    while (!iterResult.done) {
      if (responseConfig.events) streamEvents.push(iterResult.value)
      iterResult = await it.next()
    }
    const result: TurnResult = iterResult.value

    if (result.commitStatus === 'skipped') {
      return { sessionId: result.sessionId, status: 'skipped', output: emptyOutput }
    }
    if (result.commitStatus === 'orphaned') {
      return {
        ...formatResponse(result, responseConfig, streamEvents),
        warning: 'Response events were not persisted due to a concurrent session conflict',
      }
    }

    return formatResponse(result, responseConfig, streamEvents)
  }
}

const emptyOutput: Output = { items: [] }

function formatResponse(
  result: RunResult & { sessionId: string },
  responseConfig: HandlerConfig['response'],
  streamEvents: StreamEvent[],
): RestResponse {
  const base: RestResponse = {
    sessionId: result.sessionId,
    status: result.status,
    output: result.output,
  }

  if (result.status === 'yielded_tool') {
    base.yieldedTools = result.yieldedTools.map((c) => ({
      callId: c.callId,
      name: c.name,
      args: c.args,
    }))
  }

  if (result.status === 'error') {
    base.error = result.error
  }

  if (responseConfig?.events) {
    base.events = streamEvents as Event[]
  }

  if (responseConfig?.state) {
    base.state = { ...result.state }
  }

  if (responseConfig?.usage && result.usage) {
    base.usage = result.usage
  }

  return base
}
