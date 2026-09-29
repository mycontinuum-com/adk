import { z } from 'zod'

import type { ToolCallEvent } from '../types/events'

import { adk } from '../api/app'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter, type MockAdapterConfig } from '../testing'
import { agent } from './index'

const app = adk()

/** A mock adapter that records every invocation the loop says has ended. */
class ReleasingAdapter extends MockAdapter {
  readonly ended: string[] = []
  endInvocation(invocationId: string) {
    this.ended.push(invocationId)
  }
}

const done = app.tool({
  name: 'done',
  description: 'Finish.',
  schema: z.object({ message: z.string() }),
  execute: (ctx) => ctx.output(ctx.args),
})
const ask = app.tool({
  name: 'ask',
  description: 'Ask the user.',
  schema: z.object({ question: z.string() }),
  yieldSchema: z.object({ answer: z.string() }),
  finalize: (ctx) => ({ answer: ctx.input!.answer }),
})
const fail = app.tool({
  name: 'fail',
  description: 'Fails.',
  schema: z.object({}),
  execute: () => {
    throw new Error('Tool failed')
  },
})

function setup(responses: MockAdapterConfig['responses']) {
  const adapter = new ReleasingAdapter({ responses })
  const runner = new BaseRunner({
    sessionService: sessionService(inMemoryStore()),
    adapters: { openai: adapter },
  })
  const backend = agent({
    name: 'backend',
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    tools: [done, ask, fail],
    maxSteps: 3,
  })
  const session = new BaseSession('end-invocation')
  session.input.message('Hello')
  return { adapter, runner, backend, session }
}

function invocationIds(session: BaseSession) {
  return [...new Set(session.events.map((event) => event.invocationId))]
}

describe('the adapter is told when an invocation ends', () => {
  it('once, when the invocation ends on a tool that gives the output', async () => {
    const { adapter, runner, backend, session } = setup([
      { toolCalls: [{ name: 'done', args: { message: 'Bye' } }] },
    ])
    const result = await runner.run(backend, session)
    expect(result.status).toBe('completed')
    expect(adapter.ended).toEqual(invocationIds(session))
    expect(adapter.ended).toHaveLength(1)
  })

  it('once, when the invocation ends on a text reply', async () => {
    const { adapter, runner, backend, session } = setup([{ text: 'Hello there' }])
    await runner.run(backend, session)
    expect(adapter.ended).toEqual(invocationIds(session))
  })

  it('once, when the invocation ends at its step limit', async () => {
    const { adapter, runner, backend, session } = setup([
      { toolCalls: [{ name: 'fail', args: {} }] },
      { toolCalls: [{ name: 'fail', args: {} }] },
      { toolCalls: [{ name: 'fail', args: {} }] },
    ])
    const result = await runner.run(backend, session)
    expect(result.status).toBe('max_steps')
    expect(adapter.ended).toEqual(invocationIds(session))
  })

  it('not while the invocation yields for input, and once when it is resumed and ends', async () => {
    const { adapter, runner, backend, session } = setup([
      { toolCalls: [{ name: 'ask', args: { question: 'Which day?' } }] },
      { toolCalls: [{ name: 'done', args: { message: 'Monday it is' } }] },
    ])
    const yielded = await runner.run(backend, session)
    expect(yielded.status).toBe('yielded_tool')
    expect(adapter.ended).toEqual([])
    const call = session.events.find(
      (event): event is ToolCallEvent => event.type === 'tool_call' && event.name === 'ask',
    )
    session.input.tool({ callId: call!.callId, input: { answer: 'Monday' } })
    const resumed = await runner.run(backend, session)
    expect(resumed.status).toBe('completed')
    expect(adapter.ended).toEqual(invocationIds(session))
    expect(adapter.ended).toHaveLength(1)
  })
})
