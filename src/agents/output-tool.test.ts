import { z } from 'zod'

import { adk } from '../api/app'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter } from '../testing'
import { agent } from './index'

const app = adk()
const completed: unknown[] = []
/** An output tool that returns its value instead of calling ctx.output. */
const completeCall = app.tool({
  name: 'complete_call',
  description: 'Record how the call ended.',
  schema: z.object({ summary: z.string() }),
  execute: (ctx) => {
    completed.push(ctx.args)
    return { recorded: ctx.args.summary }
  },
})
const lookup = app.tool({
  name: 'lookup',
  description: 'Look something up.',
  schema: z.object({}),
  execute: () => ({ found: true }),
})

async function run(tools: (typeof lookup | typeof completeCall)[]) {
  const adapter = new MockAdapter({
    responses: [
      { toolCalls: [{ name: 'complete_call', args: { summary: 'Asked for a fit note' } }] },
      { text: 'Never reached' },
    ],
  })
  const runner = new BaseRunner({
    sessionService: sessionService(inMemoryStore()),
    adapters: { openai: adapter },
  })
  const session = new BaseSession('output-tool')
  session.input.message('Bye')
  const result = await runner.run(
    agent({
      name: 'backend',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools,
      output: completeCall,
    }),
    session,
  )
  return { result, adapter, session }
}

beforeEach(() => {
  completed.length = 0
})

describe('an output tool in the text loop', () => {
  it('runs when it is offered only as the output, and its value ends the turn', async () => {
    const { result, adapter, session } = await run([lookup])
    expect(adapter.stepCalls[0]!.ctx.functionTools.map((tool) => tool.name)).toEqual([
      'lookup',
      'complete_call',
    ])
    expect(completed).toEqual([{ summary: 'Asked for a fit note' }])
    expect(result.status).toBe('completed')
    expect(result.output.value).toEqual({ recorded: 'Asked for a fit note' })
    expect(adapter.stepCalls).toHaveLength(1)
    const toolResult = session.events.find((event) => event.type === 'tool_result')
    expect(toolResult).toMatchObject({ name: 'complete_call', output: true })
    expect(toolResult).not.toHaveProperty('error')
  })

  it('ends the turn with its value when it is also listed in tools, as it is offered', async () => {
    const { result, adapter } = await run([lookup, completeCall])
    expect(completed).toEqual([{ summary: 'Asked for a fit note' }])
    expect(result.output.value).toEqual({ recorded: 'Asked for a fit note' })
    expect(adapter.stepCalls).toHaveLength(1)
  })
})
