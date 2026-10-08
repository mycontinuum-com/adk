import { vi } from 'vitest'

import type { ErrorHandler } from '../errors'
import type { Hook } from '../hook/types'
import type { ModelAdapter, ModelStepResult, RenderContext, Session, StreamEvent } from '../types'

import { BaseRunner } from '../core'
import { createEventId } from '../core/constants'
import { createTestSession, testAgent } from '../testing'

type DuringModel = NonNullable<Hook['duringModel']>
type ModelStream = AsyncGenerator<StreamEvent, ModelStepResult>
type Step = (ctx: RenderContext, signal: AbortSignal) => ModelStream

const HOOK_REPLY = 'From the hook'
const MODEL_REPLY = 'From the model'
const MODEL_DELTAS = ['From ', 'the ', 'model'] as const
const RETRY_REPLY = 'From the retry'
const MODEL_FAILURE = 'model failed'
const RUN_ABORTED = 'Aborted'
const STEP_EVENT_TYPES = ['model_start', 'model_end', 'assistant']

function gate() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function reply(ctx: RenderContext, text: string): ModelStepResult {
  return {
    stepEvents: [
      {
        id: createEventId(),
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: ctx.invocationId,
        agentName: ctx.agentName,
        text,
      },
    ],
    toolCalls: [],
    terminal: true,
  }
}

function delta(ctx: RenderContext, text: string): StreamEvent {
  return {
    id: createEventId(),
    type: 'assistant_delta',
    createdAt: Date.now(),
    invocationId: ctx.invocationId,
    agentName: ctx.agentName,
    delta: text,
    text,
  }
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('the model call was cancelled')), {
      once: true,
    })
  })
}

function stepTypes(session: Session) {
  return session.events.flatMap((event) =>
    event.type === 'model_start' || event.type === 'model_end' || event.type === 'assistant'
      ? [event.type]
      : [],
  )
}

const aborted = (signals: AbortSignal[]) => signals.map((signal) => signal.aborted)

function startTurn(step: Step, ...duringModels: DuringModel[]) {
  const modelSignals: AbortSignal[] = []
  const hookSignals: AbortSignal[] = []
  const adapter: ModelAdapter = {
    step(ctx, _config, signal) {
      if (!signal) throw new Error('the runner gives every model call a signal')
      modelSignals.push(signal)
      return step(ctx, signal)
    },
  }
  const streamed: string[] = []
  const firstStreamed = gate()
  const atFirstDelta: { hookTold?: boolean[] } = {}
  const handled: string[] = []
  const errorHandler: ErrorHandler = {
    handle: (ctx) => {
      handled.push(ctx.error.message)
      return { action: handled.length === 1 ? 'retry' : 'throw' }
    },
  }
  const session = createTestSession('Hello')
  const run = new BaseRunner({ adapters: { openai: adapter } }).run(testAgent(), session, {
    errorHandlers: [errorHandler],
    hooks: [
      {
        onEvent: (event) => {
          if (event.type !== 'assistant_delta') return
          atFirstDelta.hookTold ??= aborted(hookSignals)
          streamed.push(event.delta)
          firstStreamed.resolve()
        },
      },
      ...duringModels.map((duringModel): Hook => ({
        duringModel: (ctx, renderCtx, signal) => {
          hookSignals.push(signal)
          return duringModel(ctx, renderCtx, signal)
        },
      })),
    ],
  })
  return {
    run,
    session,
    modelSignals,
    hookSignals,
    streamed,
    firstStreamed,
    atFirstDelta,
    handled,
  }
}

describe('duringModel', () => {
  test('the model call is already running when the hook answers', async () => {
    const modelStarted = gate()
    const f = startTurn(
      async function* (_ctx, signal) {
        modelStarted.resolve()
        return await untilAborted(signal)
      },
      async (_ctx, renderCtx) => {
        await modelStarted.promise
        return reply(renderCtx, HOOK_REPLY)
      },
    )

    const result = await f.run

    expect(result.output.text).toBe(HOOK_REPLY)
  })

  test('a step from the hook cancels the model call and replaces it without a trace', async () => {
    const held = gate()
    const f = startTurn(
      async function* (ctx, signal) {
        yield delta(ctx, MODEL_DELTAS[0])
        held.resolve()
        return await untilAborted(signal)
      },
      async (_ctx, renderCtx) => {
        await held.promise
        return reply(renderCtx, HOOK_REPLY)
      },
    )

    const result = await f.run

    expect(result.output.text).toBe(HOOK_REPLY)
    expect(result.iterations).toBe(0)
    expect(aborted(f.modelSignals)).toEqual([true])
    expect(aborted(f.hookSignals)).toEqual([false])
    expect(f.streamed).toEqual([])
    expect(f.handled).toEqual([])
    expect(stepTypes(f.session)).toEqual(STEP_EVENT_TYPES)
  })

  test('holds the model stream until the hook declines, then releases it in order', async () => {
    const held = gate()
    const declined = gate()
    let streamedWhenDeclining: string[] | undefined
    const f = startTurn(
      async function* (ctx) {
        yield delta(ctx, MODEL_DELTAS[0])
        yield delta(ctx, MODEL_DELTAS[1])
        held.resolve()
        await declined.promise
        yield delta(ctx, MODEL_DELTAS[2])
        return reply(ctx, MODEL_REPLY)
      },
      async () => {
        await held.promise
        streamedWhenDeclining = [...f.streamed]
        declined.resolve()
      },
    )

    const result = await f.run

    expect(streamedWhenDeclining).toEqual([])
    expect(f.streamed).toEqual([...MODEL_DELTAS])
    expect(result.output.text).toBe(MODEL_REPLY)
    expect(result.iterations).toBe(1)
    expect(aborted(f.modelSignals)).toEqual([false])
    expect(aborted(f.hookSignals)).toEqual([false])
  })

  test('a hook that rejects leaves the step to the model', async () => {
    const held = gate()
    const f = startTurn(
      async function* (ctx) {
        yield delta(ctx, MODEL_DELTAS[0])
        held.resolve()
        await f.firstStreamed.promise
        yield delta(ctx, MODEL_DELTAS[1])
        return reply(ctx, MODEL_REPLY)
      },
      async () => {
        await held.promise
        throw new Error('decision failed')
      },
    )

    const result = await f.run

    expect(result.output.text).toBe(MODEL_REPLY)
    expect(f.streamed).toEqual([MODEL_DELTAS[0], MODEL_DELTAS[1]])
    expect(f.handled).toEqual([])
  })

  test('a model step that finishes first is used, and the hook is told its answer is too late', async () => {
    const lateAnswer = gate()
    const duringModel = vi.fn<DuringModel>(async (_ctx, renderCtx) => {
      await lateAnswer.promise
      return reply(renderCtx, HOOK_REPLY)
    })
    const f = startTurn(async function* (ctx) {
      yield delta(ctx, MODEL_DELTAS[0])
      return reply(ctx, MODEL_REPLY)
    }, duringModel)

    const result = await f.run
    const hookToldWhenTheRunEnded = aborted(f.hookSignals)
    lateAnswer.resolve()
    await f.run.settled

    expect(duringModel).toHaveBeenCalledTimes(1)
    expect(hookToldWhenTheRunEnded).toEqual([true])
    expect(result.output.text).toBe(MODEL_REPLY)
    expect(f.streamed).toEqual([MODEL_DELTAS[0]])
    expect(stepTypes(f.session)).toEqual(STEP_EVENT_TYPES)
    expect(aborted(f.modelSignals)).toEqual([false])
  })

  test('tells a slower hook before it releases the events held for it', async () => {
    const f = startTurn(
      async function* (ctx) {
        yield delta(ctx, MODEL_DELTAS[0])
        return reply(ctx, MODEL_REPLY)
      },
      () => new Promise<never>(() => {}),
    )

    await f.run

    expect(f.streamed).toEqual([MODEL_DELTAS[0]])
    expect(f.atFirstDelta.hookTold).toEqual([true])
  })

  test('only the first model attempt is raced, and its failure tells the hook', async () => {
    const retried = gate()
    let hookToldBeforeTheRetry: boolean[] | undefined
    const duringModel = vi.fn<DuringModel>(async (_ctx, renderCtx) => {
      await retried.promise
      return reply(renderCtx, HOOK_REPLY)
    })
    let attempts = 0
    const f = startTurn(async function* (ctx) {
      if (++attempts === 1) throw new Error(MODEL_FAILURE)
      hookToldBeforeTheRetry = aborted(f.hookSignals)
      yield delta(ctx, RETRY_REPLY)
      await f.firstStreamed.promise
      retried.resolve()
      return reply(ctx, RETRY_REPLY)
    }, duringModel)

    const result = await f.run

    expect(duringModel).toHaveBeenCalledTimes(1)
    expect(hookToldBeforeTheRetry).toEqual([true])
    expect(f.handled).toEqual([MODEL_FAILURE])
    expect(result.output.text).toBe(RETRY_REPLY)
    expect(f.streamed).toEqual([RETRY_REPLY])
  })

  test('asks several hooks in order, each once the one before has declined', async () => {
    const [declines, answers, unasked] = ['declines', 'answers', 'unasked']
    const asked: string[] = []
    const f = startTurn(
      async function* (_ctx, signal) {
        return await untilAborted(signal)
      },
      async () => {
        asked.push(declines)
      },
      async (_ctx, renderCtx) => {
        asked.push(answers)
        return reply(renderCtx, HOOK_REPLY)
      },
      async () => {
        asked.push(unasked)
      },
    )

    const result = await f.run

    expect(result.output.text).toBe(HOOK_REPLY)
    expect(asked).toEqual([declines, answers])
    expect(aborted(f.hookSignals)).toEqual([false, false])
  })

  test('closes the model stream it stops reading', async () => {
    let closed = false
    const stream: ModelStream = {
      next: () => new Promise<never>(() => {}),
      return: async (value) => {
        closed = true
        return { done: true, value: await value }
      },
      throw: async (error) => {
        throw error
      },
      [Symbol.asyncIterator]: () => stream,
    }
    const f = startTurn(
      () => stream,
      async (_ctx, renderCtx) => reply(renderCtx, HOOK_REPLY),
    )

    const result = await f.run

    expect(result.output.text).toBe(HOOK_REPLY)
    expect(closed).toBe(true)
  })

  test("the caller's abort reaches the model call while the hook is still working", async () => {
    const modelStarted = gate()
    const f = startTurn(
      async function* (_ctx, signal) {
        modelStarted.resolve()
        return await untilAborted(signal)
      },
      () => new Promise<never>(() => {}),
    )
    const outcome = Promise.resolve(f.run).catch((error: Error) => error)

    await modelStarted.promise
    f.run.abort()

    expect(await outcome).toMatchObject({ message: RUN_ABORTED })
    await f.run.settled
    expect(aborted(f.modelSignals)).toEqual([true])
  })

  test("the caller's abort tells the hook, and a step it then returns is not used", async () => {
    const modelStarted = gate()
    const callerAborted = gate()
    let hookToldOnAbort: boolean | undefined
    const f = startTurn(
      async function* () {
        modelStarted.resolve()
        return await new Promise<never>(() => {})
      },
      async (_ctx, renderCtx, signal) => {
        await callerAborted.promise
        hookToldOnAbort = signal.aborted
        return reply(renderCtx, HOOK_REPLY)
      },
    )
    const outcome = Promise.resolve(f.run).catch((error: Error) => error)

    await modelStarted.promise
    f.run.abort()
    callerAborted.resolve()

    expect(await outcome).toMatchObject({ message: RUN_ABORTED })
    await f.run.settled
    expect(hookToldOnAbort).toBe(true)
    expect(stepTypes(f.session)).toEqual(STEP_EVENT_TYPES.slice(0, 1))
  })
})
