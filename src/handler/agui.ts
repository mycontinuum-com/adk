import type { AGUIEvent } from '@ag-ui/core'

import type { StateSchema } from '../types/schema'
import type { HandlerInput, HandlerConfig } from './types'

import { turn } from './turn'

export function aguiHandler<S extends StateSchema>(
  config: HandlerConfig<S>,
): (input: HandlerInput) => AsyncIterable<AGUIEvent> {
  return (input: HandlerInput): AsyncIterable<AGUIEvent> => {
    return {
      [Symbol.asyncIterator]() {
        return generateEvents(config, input)
      },
    }
  }
}

async function* generateEvents<S extends StateSchema>(
  config: HandlerConfig<S>,
  input: HandlerInput,
): AsyncGenerator<AGUIEvent> {
  const { AgUIAdapter } = await import('../agui/adapter.js')
  const turnStream = turn(config, input)
  const adapter = new AgUIAdapter(turnStream.sessionId, turnStream.invocationId)

  yield adapter.runStarted()
  yield adapter.stateSnapshot({})

  try {
    const it = turnStream[Symbol.asyncIterator]()
    let iterResult = await it.next()
    while (!iterResult.done) {
      for (const aguiEvent of adapter.transform(iterResult.value)) {
        yield aguiEvent
      }
      iterResult = await it.next()
    }
    const result = iterResult.value

    if (result.status === 'error') {
      yield adapter.runError(result.error)
      return
    }
    if (result.status === 'aborted') {
      yield adapter.runError('Run was aborted')
      return
    }
    if (result.status === 'yielded_tool') {
      const pending = result.yieldedTools[0]
      for (const event of adapter.runInterrupted({
        id: pending?.callId,
        reason: 'tool_yield',
        payload: pending ? { toolName: pending.name, args: pending.args } : undefined,
      })) {
        yield event
      }
    } else if (result.status === 'yielded_message') {
      for (const event of adapter.runInterrupted({
        id: result.yieldedInvocationId,
        reason: 'input_required',
      })) {
        yield event
      }
    }

    yield adapter.runFinished({ commitStatus: result.commitStatus })
  } catch (err) {
    yield adapter.runError(err instanceof Error ? err.message : String(err))
  }
}
