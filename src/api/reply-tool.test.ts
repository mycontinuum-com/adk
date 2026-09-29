import { z } from 'zod'

import { agent } from '../agents'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter, type MockAdapterConfig } from '../testing'
import { adk } from './app'

const app = adk()
const reply = z.object({ message: z.string().min(1) })
const replyTool = app.replyTool({ description: 'Say this to the caller.', schema: reply })
const ended: string[] = []
const endCall = app.tool({
  name: 'end_call',
  description: 'End the call.',
  schema: z.object({}),
  execute: () => {
    ended.push('end_call')
    return { ended: true }
  },
})

function backend(toolChoice: 'auto' | 'required') {
  return agent({
    name: 'backend',
    model: openai('gpt-4o-mini'),
    context: [includeHistory(), app.context.toolChoice(toolChoice)],
    tools: [replyTool, endCall],
    output: { schema: reply },
  })
}

async function run(toolChoice: 'auto' | 'required', responses: MockAdapterConfig['responses']) {
  const adapter = new MockAdapter({ responses })
  const runner = new BaseRunner({
    sessionService: sessionService(inMemoryStore()),
    adapters: { openai: adapter },
  })
  const session = new BaseSession('reply-tool')
  session.input.message('Thanks, bye')
  const result = await runner.run(backend(toolChoice), session)
  return { result, adapter, session }
}

beforeEach(() => {
  ended.length = 0
})

describe('app.replyTool', () => {
  it('ends the turn with its arguments, the value a text reply against the same schema gives', async () => {
    const byTool = await run('required', [
      { toolCalls: [{ name: 'reply', args: { message: 'Is there anything else?' } }] },
      { text: 'Never reached' },
    ])
    const byText = await run('auto', [{ text: '{"message":"Is there anything else?"}' }])
    expect(byTool.result.status).toBe('completed')
    expect(byTool.result.output.value).toEqual({ message: 'Is there anything else?' })
    expect(byText.result.output.value).toEqual({ message: 'Is there anything else?' })
    expect(byTool.adapter.stepCalls).toHaveLength(1)
  })

  it('is offered as a tool with the output schema, beside the tools of a required step', async () => {
    const { adapter } = await run('required', [
      { toolCalls: [{ name: 'reply', args: { message: 'Goodbye' } }] },
    ])
    const ctx = adapter.stepCalls[0]!.ctx
    expect(ctx.toolChoice).toBe('required')
    expect(ctx.functionTools.map((tool) => tool.name)).toEqual(['reply', 'end_call'])
    expect(ctx.functionTools[0]!.schema).toBe(reply)
    expect(ctx.functionTools[0]!.name).toBe('reply')
  })

  it('rejects arguments outside the output schema, and the model can reply again', async () => {
    const { result, adapter, session } = await run('required', [
      { toolCalls: [{ name: 'reply', args: { message: '' } }] },
      { toolCalls: [{ name: 'reply', args: { message: 'Take care' } }] },
    ])
    expect(result.output.value).toEqual({ message: 'Take care' })
    expect(adapter.stepCalls).toHaveLength(2)
    const results = session.events.filter((event) => event.type === 'tool_result')
    expect(results.map((event) => Boolean(event.error))).toEqual([true, false])
  })

  it('a reply before an exit in one step ends the turn, and the exit is not run', async () => {
    const { result, session } = await run('required', [
      {
        toolCalls: [
          { name: 'reply', args: { message: 'One moment' } },
          { name: 'end_call', args: {} },
        ],
      },
    ])
    expect(result.output.value).toEqual({ message: 'One moment' })
    expect(ended).toEqual([])
    const skipped = session.events.find(
      (event) => event.type === 'tool_result' && event.name === 'end_call',
    )
    expect(skipped).toMatchObject({ error: 'Not run: reply ended the turn first.' })
  })

  it('takes another name', () => {
    expect(app.replyTool({ name: 'say', description: 'Say it.', schema: reply }).name).toBe('say')
  })
})
