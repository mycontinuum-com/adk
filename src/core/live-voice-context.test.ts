import { z } from 'zod'

import type { InvocationContext } from '../types/runnables'
import type { LiveVoiceControls } from '../voice/live-types'

import { adk } from '../api'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing/mock/adapter'

function controls(messages: string[]): LiveVoiceControls {
  return {
    end: () => messages.push('end'),
    appendThinking: (text) => messages.push(`thinking:${text}`),
    appendCommentary: (text) => messages.push(`commentary:${text}`),
    appendInstructions: (text) => messages.push(`instructions:${text}`),
    turnCount: 0,
  }
}

test('app.run exposes native Live controls to backend tools and invocation/tool hooks', async () => {
  const adapter = new MockAdapter({ responses: [{ toolCalls: [{ name: 'lookup', args: {} }] }] })
  const app = adk({ adapters: { openai: adapter } })
  const messages: string[] = []
  const voice = controls(messages)
  const backend = app.agent({
    name: 'backend',
    model: openai('mock'),
    context: [],
    tools: [
      app.tool({
        name: 'lookup',
        description: 'Synthetic lookup',
        schema: z.object({}),
        execute(ctx) {
          expect(ctx.voice).toBe(voice)
          if (ctx.voice && 'appendCommentary' in ctx.voice) ctx.voice.appendCommentary('Found it')
          return ctx.output('done')
        },
      }),
    ],
  })
  try {
    const run = app.run(backend, {
      voice,
      hooks: [
        {
          beforeAgent(ctx) {
            expect(ctx.voice).toBe(voice)
            if (ctx.voice && 'appendThinking' in ctx.voice)
              ctx.voice.appendThinking('Check practice facts')
          },
          beforeTool(ctx) {
            expect(ctx.voice).toBe(voice)
            if (ctx.voice && 'appendCommentary' in ctx.voice) ctx.voice.appendCommentary('Checking')
          },
          afterTool(ctx) {
            expect(ctx.voice).toBe(voice)
            if (ctx.voice && 'appendInstructions' in ctx.voice)
              ctx.voice.appendInstructions('Keep this brief')
          },
        },
      ],
    })
    expect((await run).output.value).toBe('done')
    await run.settled
    expect(messages).toEqual([
      'thinking:Check practice facts',
      'commentary:Checking',
      'commentary:Found it',
      'instructions:Keep this brief',
    ])
  } finally {
    await app.close()
  }
})

test('child runs inherit the same controls without leaking across concurrent voice and text runs', async () => {
  const adapter = new MockAdapter()
  adapter.addResponses(
    'agent:parent',
    Array.from({ length: 3 }, () => ({ toolCalls: [{ name: 'delegate', args: {} }] })),
  )
  adapter.addResponses(
    'agent:child',
    Array.from({ length: 3 }, () => ({ toolCalls: [{ name: 'answer', args: {} }] })),
  )
  const app = adk({ adapters: { openai: adapter } })
  const observed = new Map<string, Array<InvocationContext['voice']>>()
  function remember(ctx: Pick<InvocationContext, 'session' | 'voice'>) {
    const input = ctx.session.events.find((event) => event.type === 'user')
    if (!input || input.type !== 'user') throw new Error('Missing test input')
    const values = observed.get(input.text) ?? []
    values.push(ctx.voice)
    observed.set(input.text, values)
  }
  const child = app.agent({
    name: 'child',
    model: openai('mock'),
    context: [],
    hooks: [{ beforeAgent: remember }],
    tools: [
      app.tool({
        name: 'answer',
        description: 'Synthetic answer',
        schema: z.object({}),
        execute(ctx) {
          remember(ctx)
          return ctx.output('child answer')
        },
      }),
    ],
  })
  const parent = app.agent({
    name: 'parent',
    model: openai('mock'),
    context: [],
    hooks: [{ beforeAgent: remember }],
    tools: [
      app.tool({
        name: 'delegate',
        description: 'Delegate',
        schema: z.object({}),
        async execute(ctx) {
          remember(ctx)
          const result = await ctx.run(child)
          return ctx.output(result.output.value)
        },
      }),
    ],
  })
  const first = controls([]),
    second = controls([])
  try {
    const runs = [
      app.run(parent, { input: 'first', voice: first }),
      app.run(parent, { input: 'second', voice: second }),
      app.run(parent, { input: 'text' }),
    ]
    const results = await Promise.all(runs)
    await Promise.all(runs.map((run) => run.settled))
    expect(results.map((result) => result.output.value)).toEqual([
      'child answer',
      'child answer',
      'child answer',
    ])
    expect(observed.get('first')).toEqual([first, first, first, first])
    expect(observed.get('second')).toEqual([second, second, second, second])
    expect(observed.get('text')).toEqual([undefined, undefined, undefined, undefined])
  } finally {
    await app.close()
  }
})
