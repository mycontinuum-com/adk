import { expect, it } from 'vitest'
import { z } from 'zod'
import { z as z3 } from 'zod/v3'

import { MockAdapter } from '../testing'
import { adk } from './app'

function stage(value: z.ZodType<string> = z.string().default('stage default')) {
  const app = adk({ name: 'stage', schema: { session: { value, result: z.string().optional() } } })
  const agent = app.agent({
    name: 'stage-model',
    model: { provider: 'openai', name: 'mock' },
    context: [app.context.user((ctx) => ctx.state.value)],
    output: { schema: z.object({ value: z.string() }) },
  })
  const runnable = app.step({
    name: 'stage-root',
    execute: async (ctx) => {
      const result = await ctx.run(agent)
      if (result.status !== 'completed') throw new Error(result.error ?? result.status)
      ctx.state.result = result.output.value?.value
      ctx.output(ctx.state.result)
    },
  })
  return { app, runnable }
}

it('binds narrow state with the parent adapter, output, defaults and invocation ancestry', async () => {
  const child = stage()
  const adapter = new MockAdapter({ responses: [{ text: '{"value":"done"}' }] })
  const parent = adk({
    name: 'parent',
    schema: { session: { ...child.app.schema.session, extra: z.number().default(9) } },
    adapters: { openai: adapter },
  })
  const bound = parent.bind(child)
  const run = await parent.run(bound, { input: { state: {} } })
  expect(run.status).toBe('completed')
  expect(run.output.value).toBe('done')
  expect(run.state).toMatchObject({ value: 'stage default', result: 'done', extra: 9 })
  const starts = [
    ...new Map(
      run.session.events
        .filter((e) => e.type === 'invocation_start')
        .map((event) => [event.invocationId, event]),
    ).values(),
  ]
  expect(starts.map((e) => e.agentName)).toEqual(['bind-stage-root', 'stage-root', 'stage-model'])
  expect(starts[1].parentInvocationId).toBe(starts[0].invocationId)
  expect(starts[2].parentInvocationId).toBe(starts[1].invocationId)
  expect(adapter.stepCalls).toHaveLength(1)
  await parent.close()
  await child.app.close()
})

it('rejects invalid child input before running the child', async () => {
  const child = stage(z.string().min(3))
  const adapter = new MockAdapter()
  const parent = adk({
    name: 'parent',
    schema: { session: { ...child.app.schema.session, value: z.string() } },
    adapters: { openai: adapter },
  })
  const run = await parent.run(parent.bind(child), { input: { state: { value: 'x' } } })
  expect(run.status).toBe('error')
  expect(run.output.value).toBeUndefined()
  expect(adapter.stepCalls).toHaveLength(0)
  await parent.close()
  await child.app.close()
})

it('rejects incompatible schema keys and shared scopes', () => {
  const child = stage()
  const missing = adk({ name: 'missing', schema: { session: { value: z.string() } } })
  // @ts-expect-error The parent must declare every child field.
  expect(() => missing.bind(child)).toThrow("parent session schema is missing 'result'")
  const wrong = adk({
    name: 'wrong',
    schema: { session: { value: z.number(), result: z.string().optional() } },
  })
  // @ts-expect-error Child and parent field schemas must be compatible.
  const invalid = () => wrong.bind(child)
  expect(typeof invalid).toBe('function')
  const shared = adk({
    name: 'shared',
    schema: { session: { value: z.string() }, user: { name: z.string() } },
  })
  const runnable = shared.step({ name: 'shared-root', execute: () => {} })
  expect(() => shared.bind({ app: shared, runnable })).toThrow('session state only')
})

it('fails when child output violates the parent schema and does not expose output', async () => {
  const child = stage()
  const adapter = new MockAdapter({ responses: [{ text: '{"value":"bad"}' }] })
  const parent = adk({
    name: 'parent',
    schema: { session: { ...child.app.schema.session, result: z.string().min(4).optional() } },
    adapters: { openai: adapter },
  })
  const run = await parent.run(parent.bind(child), { input: { state: {} } })
  expect(run.status).toBe('error')
  expect(run.output.value).toBeUndefined()
  await parent.close()
  await child.app.close()
})

it('propagates child failure without emitting an output', async () => {
  const child = adk({ name: 'failure', schema: { session: {} } })
  const runnable = child.step({ name: 'fails', execute: (ctx) => ctx.fail('broken stage') })
  const parent = adk({ name: 'parent', schema: { session: {} } })
  const run = await parent.run(parent.bind({ app: child, runnable }), { input: { state: {} } })
  expect(run.status).toBe('error')
  expect(run.output.value).toBeUndefined()
  if (run.status === 'error') expect(run.error).toContain('broken stage')
  await parent.close()
  await child.close()
})

it('uses declared state input without forwarding the parent invocation message', async () => {
  const child = adk({ name: 'state-input', schema: { session: { value: z.string() } } })
  const runnable = child.agent({
    name: 'state-input-model',
    model: { provider: 'openai', name: 'mock' },
    context: [
      child.context.user((ctx) => ctx.state.value),
      child.context.history({ scope: 'invocation' }),
    ],
  })
  const adapter = new MockAdapter({ responses: [{ text: 'done' }] })
  const parent = adk({ name: 'parent', schema: child.schema, adapters: { openai: adapter } })
  const run = await parent.run(parent.bind({ app: child, runnable }), {
    input: { state: { value: 'Reviewed state input' }, message: 'Outer message' },
  })
  expect(run.status).toBe('completed')
  expect(
    adapter.stepCalls.flatMap((call) =>
      call.ctx.events.filter((event) => event.type === 'user').map((event) => event.text),
    ),
  ).toEqual(['Reviewed state input'])
  await parent.close()
  await child.close()
})

it('binds a Zod 3 child inside a mixed-version parent', async () => {
  const child = adk({ name: 'v3-child', schema: { session: { value: z3.string().default('v3') } } })
  const runnable = child.step({ name: 'read-value', execute: (ctx) => ctx.output(ctx.state.value) })
  const parent = adk({
    name: 'mixed-parent',
    schema: { session: { ...child.schema.session, extra: z.number().default(7) } },
  })
  const result = await parent.run(parent.bind({ app: child, runnable }), { input: { state: {} } })
  expect(result.status).toBe('completed')
  expect(result.output.value).toBe('v3')
  expect(result.state).toMatchObject({ value: 'v3', extra: 7 })
})
