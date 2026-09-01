import type { StreamEvent } from '../types'
import type { Session } from '../types'
import type { RunResult, TurnResult, Output } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { HandlerConfig, HandlerInput, TurnStream } from './types'

import { BaseRunner, createStreamResult } from '../core'
import { normalizeSessionId, createSessionId } from '../core/constants'
import { createInvocationId } from '../core/invocation'
import { BaseSession } from '../session'
import { resolveSession, applyInput, resolveConflict } from './conflict'

const emptyOutput: Output = { items: [] }

/** @deprecated Use `app.handler.turn()` instead. */
export function turn<S extends StateSchema>(
  config: HandlerConfig<S>,
  input: HandlerInput,
): TurnStream {
  const sessionId = input.sessionId ? normalizeSessionId(input.sessionId) : createSessionId()
  const invocationId = createInvocationId()
  const abortController = new AbortController()

  let resolveResult: (value: TurnResult) => void
  const resultPromise = new Promise<TurnResult>((r) => {
    resolveResult = r
  })

  async function* generate(): AsyncGenerator<StreamEvent, TurnResult> {
    if (!config.sessionService) {
      throw new Error('sessionService is required. Pass it or use app.handler.turn().')
    }
    const cfg = { ...config, sessionService: config.sessionService }

    let session: Session<S> | undefined
    try {
      session = await resolveSession(cfg, sessionId)
      const eventCountBeforeInput = session.events.length

      applyInput(session, input, cfg.schema)

      const hooks = cfg.hooks ?? []
      const runner = new BaseRunner({
        sessionService: cfg.sessionService,
        adapters: cfg.adapters,
      })
      const stream = runner.run(cfg.agent, session, {
        hooks,
        invocationId,
        timeout: cfg.timeout,
        errorHandlers: cfg.errorHandlers,
      })
      abortController.signal.addEventListener('abort', () => stream.abort(), {
        once: true,
      })

      const result: RunResult = yield* stream
      let commitStatus: TurnResult['commitStatus']

      if (result.status !== 'aborted') {
        const ctx = { session, state: session.state, result, runnable: cfg.agent }
        for (const hook of hooks) {
          await hook.afterTurn?.(ctx)
        }

        const commitResult = await cfg.sessionService.commitSession(session)
        commitStatus = commitResult.ok
          ? 'committed'
          : await resolveConflict(cfg, session, eventCountBeforeInput)
      }

      const turnResult: TurnResult = {
        ...result,
        sessionId,
        invocationId,
        commitStatus,
      }
      resolveResult(turnResult)
      return turnResult
    } catch (err) {
      console.warn('turn.error', { sessionId, error: err })
      const s = session ?? new BaseSession(cfg.appName, { id: sessionId })
      const base = {
        runnable: cfg.agent,
        session: s,
        state: s.state,
        iterations: 0,
        output: emptyOutput,
        sessionId,
        invocationId,
      }

      let turnResult: TurnResult
      if (abortController.signal.aborted) {
        turnResult = { ...base, status: 'aborted' as const }
      } else {
        turnResult = {
          ...base,
          status: 'error' as const,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      resolveResult(turnResult)
      return turnResult
    }
  }

  const stream = createStreamResult(generate(), abortController)
  return Object.assign(stream, {
    invocationId,
    sessionId,
    result: resultPromise,
  })
}
