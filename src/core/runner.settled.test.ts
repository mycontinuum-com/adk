import { vi } from 'vitest'
import { z } from 'zod'

import type { StreamEvent } from '../types'
import type { RetryConfig } from '../types/runnables'

import { adk } from '../api'
import { InMemoryChannel } from '../channels/inMemory'
import { turn } from '../handler/turn'
import { InMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter, createTestSession, testAgent } from '../testing'
import { BaseRunner, createStreamResult } from './runner'

function gate() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(execute: () => Promise<object>, timeout?: number, retry?: RetryConfig) {
  const app = adk()
  const model = new MockAdapter({
    responses: [{ toolCalls: [{ name: 'save', args: {} }] }, { text: 'Done.' }],
  })
  const tool = app.tool({
    name: 'save',
    description: 'Save',
    schema: z.object({}),
    execute,
    timeout,
    retry,
  })
  const runner = new BaseRunner({ adapters: { openai: model, gemini: model } })
  const session = createTestSession('Save this')
  return { runner, session, model, agent: testAgent({ tools: [tool] }) }
}

describe('run execution completion', () => {
  test('abort rejects promptly but settled waits for the admitted tool and terminal ledger event', async () => {
    const entered = gate(),
      release = gate()
    const f = fixture(async () => {
      entered.resolve()
      await release.promise
      return { saved: true }
    })
    const step = vi.spyOn(f.model, 'step')
    const run = f.runner.run(f.agent, f.session)
    const outcome = Promise.resolve(run).catch((error) => error)
    await entered.promise
    run.abort()
    expect(await outcome).toMatchObject({ message: 'Aborted' })
    let settled = false
    void run.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await run.settled
    expect(step).toHaveBeenCalledTimes(1)
    expect(f.session.events.filter((event) => event.type === 'tool_result')).toMatchObject([
      { result: { saved: true } },
    ])
    expect(f.session.events.filter((event) => event.type === 'invocation_end')).toMatchObject([
      { reason: 'aborted' },
    ])
  })

  test('the deadline starts at execution without waiting for result consumption', async () => {
    const entered = gate(),
      release = gate()
    const f = fixture(async () => {
      entered.resolve()
      await release.promise
      return { saved: true }
    })
    const step = vi.spyOn(f.model, 'step')
    const run = f.runner.run(f.agent, f.session, { timeout: 10 })
    await entered.promise
    await new Promise((resolve) => setTimeout(resolve, 25))
    await expect(Promise.resolve(run)).rejects.toThrow('Timeout after 10ms')
    release.resolve()
    await run.settled
    expect(step).toHaveBeenCalledTimes(1)
  })

  test.each(['beforeModel', 'beforeTool'] as const)(
    'does not admit execution after abort during %s',
    async (hook) => {
      const entered = gate(),
        release = gate()
      const execute = vi.fn<() => Promise<object>>(async () => ({ saved: true }))
      const f = fixture(execute)
      const step = vi.spyOn(f.model, 'step')
      const run = f.runner.run(f.agent, f.session, {
        hooks: [
          {
            [hook]: async () => {
              entered.resolve()
              await release.promise
            },
          },
        ],
      })
      const outcome = Promise.resolve(run).catch((error) => error)
      await entered.promise
      run.abort()
      await outcome
      release.resolve()
      await run.settled
      expect(execute).not.toHaveBeenCalled()
      expect(step).toHaveBeenCalledTimes(hook === 'beforeModel' ? 0 : 1)
    },
  )

  test('settled includes a tool body that outlives its own timeout without changing its timeout receipt', async () => {
    const entered = gate(),
      release = gate()
    const f = fixture(async () => {
      entered.resolve()
      await release.promise
      return { saved: true }
    }, 10)
    const run = f.runner.run(f.agent, f.session)
    const result = Promise.resolve(run)
    await entered.promise
    expect((await result).status).toBe('completed')
    let settled = false
    void run.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await run.settled
    expect(f.session.events.filter((event) => event.type === 'tool_result')).toMatchObject([
      { timedOut: true },
    ])
  })

  test('breaking iteration cancels producer execution', async () => {
    const execute = vi.fn<() => Promise<object>>(async () => ({ saved: true }))
    const f = fixture(execute)
    const step = vi.spyOn(f.model, 'step')
    const run = f.runner.run(f.agent, f.session)
    for await (const _event of run) break
    await run.settled
    expect(execute).not.toHaveBeenCalled()
    expect(step).not.toHaveBeenCalled()
    expect(f.session.events.filter((event) => event.type === 'invocation_end')).toMatchObject([
      { reason: 'aborted' },
    ])
  })
})

describe('owned completion edges', () => {
  test.each(['abort', 'return', 'already-aborted'] as const)(
    '%s before consumption settles without starting execution',
    async (action) => {
      let entered = false
      async function* source(): AsyncGenerator<StreamEvent, void> {
        entered = true
      }
      const controller = new AbortController()
      if (action === 'already-aborted') controller.abort(new Error('Aborted'))
      const stream = createStreamResult(source(), controller)
      if (action === 'return') await stream[Symbol.asyncIterator]().return?.()
      else stream.abort()
      await stream.settled
      await expect(Promise.resolve(stream)).rejects.toThrow('Aborted')
      expect(entered).toBe(false)
    },
  )

  test('settled waits through retry backoff after a tool timeout', async () => {
    const execute = vi.fn<() => Promise<never>>(async () => {
      throw new Error('retry me')
    })
    const f = fixture(execute, 5, {
      maxAttempts: 2,
      initialDelayMs: 50,
      maxDelayMs: 50,
      backoffMultiplier: 1,
    })
    const run = f.runner.run(f.agent, f.session)
    await run
    expect(execute).toHaveBeenCalledTimes(1)
    let settled = false
    void run.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    run.abort()
    await run.settled
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('channel drains yielded cleanup and seals registration after completion', async () => {
    const channel = new InMemoryChannel()
    const entered = gate(),
      release = gate()
    let cleaned = false
    async function* producer(): AsyncGenerator<StreamEvent, void> {
      try {
        entered.resolve()
        await release.promise
        yield {
          type: 'assistant_delta',
          id: 'work',
          createdAt: 0,
          invocationId: 'test',
          agentName: 'test',
          text: '',
          delta: '',
        }
      } finally {
        yield {
          type: 'assistant_delta',
          id: 'cleanup',
          createdAt: 0,
          invocationId: 'test',
          agentName: 'test',
          text: '',
          delta: '',
        }
        cleaned = true
      }
    }
    channel.registerGenerator('main', producer(), true)
    await entered.promise
    channel.abort()
    release.resolve()
    await channel.settled
    expect(cleaned).toBe(true)
    expect(() => channel.registerProducer()).toThrow()
    expect(() => channel.registerOperation()).toThrow()
  })

  test('runToChannel shares cancellation with its channel', async () => {
    const entered = gate(),
      release = gate()
    const f = fixture(async () => {
      entered.resolve()
      await release.promise
      return { saved: true }
    })
    const channel = new InMemoryChannel()
    const step = vi.spyOn(f.model, 'step')
    const pending = f.runner.runToChannel(f.agent, f.session, channel).catch((error) => error)
    await entered.promise
    channel.abort()
    release.resolve()
    await channel.settled
    await pending
    expect(step).toHaveBeenCalledTimes(1)
    expect(f.session.events.filter((event) => event.type === 'tool_result')).toMatchObject([
      { result: { saved: true } },
    ])
  })
})

test('handler timeout returns promptly while its completion waits for admitted execution', async () => {
  const entered = gate(),
    release = gate()
  const f = fixture(async () => {
    entered.resolve()
    await release.promise
    return { saved: true }
  })
  const stream = turn(
    {
      agent: f.agent,
      appName: 'test',
      timeout: 10,
      sessionService: sessionService(new InMemoryStore()),
      adapters: { openai: f.model, gemini: f.model },
    },
    { input: { message: 'Save' } },
  )
  const result = Promise.resolve(stream)
  await entered.promise
  expect((await result).status).toBe('error')
  let settled = false
  void stream.settled.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  await stream.settled
})

test('inline child work remains owned after its handoff timeout', async () => {
  const entered = gate(),
    release = gate()
  const app = adk()
  const child = testAgent({ name: 'child' })
  const delegate = app.tool({
    name: 'delegate',
    description: 'Run child',
    schema: z.object({}),
    execute: (ctx) => ctx.run(child, { timeout: 5 }),
  })
  const model = new MockAdapter({
    responses: [{ toolCalls: [{ name: 'delegate', args: {} }] }, { text: 'Done.' }],
  })
  const runner = new BaseRunner({ adapters: { openai: model, gemini: model } })
  const session = createTestSession('Run child')
  const step = vi.spyOn(model, 'step')
  const run = runner.run(testAgent({ name: 'parent', tools: [delegate] }), session, {
    hooks: [
      {
        beforeModel: async (_ctx, render) => {
          if (render.agent.name === 'child') {
            entered.resolve()
            await release.promise
          }
        },
      },
    ],
  })
  await entered.promise
  await run
  let settled = false
  void run.settled.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  run.abort()
  release.resolve()
  await run.settled
  expect(step).toHaveBeenCalledTimes(2)
})

test('awaiting a partially consumed stream drains the remainder', async () => {
  async function* source(): AsyncGenerator<StreamEvent, number> {
    yield {
      type: 'assistant_delta',
      id: 'one',
      createdAt: 0,
      invocationId: 'test',
      agentName: 'test',
      text: '',
      delta: '',
    }
    return 42
  }
  const stream = createStreamResult(source(), new AbortController())
  await stream[Symbol.asyncIterator]().next()
  expect(await stream).toBe(42)
  await stream.settled
})

test('await after partial iteration and abort rejects and still drains execution', async () => {
  const f = fixture(async () => ({ saved: true }))
  const stream = f.runner.run(f.agent, f.session)
  await stream[Symbol.asyncIterator]().next()
  stream.abort()
  await expect(Promise.resolve(stream)).rejects.toThrow('Aborted')
  await stream.settled
  expect(f.session.events.filter((event) => event.type === 'invocation_end')).toMatchObject([
    { reason: 'aborted' },
  ])
})
