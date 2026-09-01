import { vi } from 'vitest'
import { z } from 'zod'

import type { Hook } from './types'

import { agent } from '../agents'
import { adk } from '../api'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { MockAdapter, createTestSession, testAgent } from '../testing'
import { composeHooks } from './compose'

const app = adk()

describe('Hook', () => {
  describe('composeHooks', () => {
    it('returns empty callbacks when no hooks', () => {
      const result = composeHooks([])
      expect(result.beforeAgent).toBeUndefined()
      expect(result.afterAgent).toBeUndefined()
      expect(result.beforeModel).toBeUndefined()
      expect(result.afterModel).toBeUndefined()
      expect(result.beforeTool).toBeUndefined()
      expect(result.afterTool).toBeUndefined()
    })

    it('preserves inner hooks when no outer hooks', () => {
      const beforeAgent = vi.fn<(...args: unknown[]) => unknown>()
      const afterAgent = vi.fn<(...args: unknown[]) => unknown>()
      const inner: Hook = { beforeAgent, afterAgent }

      const result = composeHooks([inner])

      expect(result.beforeAgent).toBeDefined()
      expect(result.afterAgent).toBeDefined()
    })

    it('composes beforeAgent hooks in order (outer → inner)', async () => {
      const order: string[] = []

      const outerHook: Hook = {
        beforeAgent: () => {
          order.push('outer')
        },
      }
      const innerHook1: Hook = {
        beforeAgent: () => {
          order.push('inner1')
        },
      }
      const innerHook2: Hook = {
        beforeAgent: () => {
          order.push('inner2')
        },
      }

      const composed = composeHooks([outerHook, innerHook1, innerHook2])
      await composed.beforeAgent!({} as any)

      expect(order).toEqual(['outer', 'inner1', 'inner2'])
    })

    it('composes afterAgent hooks in reverse order (inner → outer)', async () => {
      const order: string[] = []

      const outerHook: Hook = {
        afterAgent: () => {
          order.push('outer')
        },
      }
      const innerHook1: Hook = {
        afterAgent: () => {
          order.push('inner1')
        },
      }
      const innerHook2: Hook = {
        afterAgent: () => {
          order.push('inner2')
        },
      }

      const composed = composeHooks([outerHook, innerHook1, innerHook2])
      await composed.afterAgent!({} as any, 'output')

      expect(order).toEqual(['inner2', 'inner1', 'outer'])
    })

    it('short-circuits beforeAgent when a hook returns a value', async () => {
      const order: string[] = []

      const hook1: Hook = {
        beforeAgent: () => {
          order.push('hook1')
          return 'short-circuit'
        },
      }
      const hook2: Hook = {
        beforeAgent: () => {
          order.push('hook2')
        },
      }

      const composed = composeHooks([hook1, hook2])
      const result = await composed.beforeAgent!({} as any)

      expect(result).toBe('short-circuit')
      expect(order).toEqual(['hook1'])
    })

    it('allows afterAgent hooks to transform output', async () => {
      const hook1: Hook = {
        afterAgent: (_, output) => `${output}-hook1`,
      }
      const hook2: Hook = {
        afterAgent: (_, output) => `${output}-hook2`,
      }

      const composed = composeHooks([hook1, hook2])
      const result = await composed.afterAgent!({} as any, 'original')

      expect(result).toBe('original-hook2-hook1')
    })

    it('allows afterModel hooks to transform result', async () => {
      const hook: Hook = {
        afterModel: (_, result) => ({
          ...result,
          terminal: true,
        }),
      }

      const composed = composeHooks([hook])
      const input = { stepEvents: [], toolCalls: [], terminal: false }
      const result = await composed.afterModel!({} as any, input)

      expect(result && 'terminal' in result && result.terminal).toBe(true)
    })
  })

  describe('Agent-level hooks', () => {
    it('calls hooks during execution', async () => {
      const called: string[] = []

      const hook: Hook = {
        beforeAgent: () => {
          called.push('beforeAgent')
        },
        afterAgent: () => {
          called.push('afterAgent')
        },
        beforeModel: () => {
          called.push('beforeModel')
        },
        afterModel: () => {
          called.push('afterModel')
        },
      }

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Hello!' }],
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        hooks: [hook],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = createTestSession('Hi')
      await runner.run(myAgent, session)

      expect(called).toContain('beforeAgent')
      expect(called).toContain('beforeModel')
      expect(called).toContain('afterModel')
      expect(called).toContain('afterAgent')
    })

    it('calls tool hooks during tool execution', async () => {
      const called: string[] = []

      const hook: Hook = {
        beforeTool: (ctx, call) => {
          called.push(`beforeTool:${call.name}`)
        },
        afterTool: (ctx, result) => {
          called.push(`afterTool:${result.name}`)
        },
      }

      const myTool = app.tool({
        name: 'greet',
        description: 'Greet someone',
        schema: z.object({ name: z.string() }),
        execute: (ctx) => `Hello, ${ctx.args.name}!`,
      })

      const mockAdapter = new MockAdapter({
        responses: [{ toolCalls: [{ name: 'greet', args: { name: 'World' } }] }, { text: 'Done!' }],
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [myTool],
        hooks: [hook],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = createTestSession('Greet me')
      await runner.run(myAgent, session)

      expect(called).toContain('beforeTool:greet')
      expect(called).toContain('afterTool:greet')
    })
  })

  describe('Runner-level hooks', () => {
    it('applies runner hooks to all agents', async () => {
      const called: string[] = []

      const runnerHook: Hook = {
        beforeAgent: (ctx) => {
          called.push(`runner:beforeAgent:${ctx.runnable.name}`)
        },
        afterAgent: (ctx) => {
          called.push(`runner:afterAgent:${ctx.runnable.name}`)
        },
      }

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Response' }],
      })

      const myAgent = testAgent({ name: 'my-agent' })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
        hooks: [runnerHook],
      })

      const session = createTestSession('Test')
      await runner.run(myAgent, session)

      expect(called).toContain('runner:beforeAgent:my-agent')
      expect(called).toContain('runner:afterAgent:my-agent')
    })
  })

  describe('Combined runner and agent hooks', () => {
    it('composes in correct order (runner wraps agent)', async () => {
      const order: string[] = []

      const runnerHook: Hook = {
        beforeAgent: () => {
          order.push('runner:before')
        },
        afterAgent: () => {
          order.push('runner:after')
        },
      }

      const agentHook: Hook = {
        beforeAgent: () => {
          order.push('agent:before')
        },
        afterAgent: () => {
          order.push('agent:after')
        },
      }

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Test' }],
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        hooks: [agentHook],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
        hooks: [runnerHook],
      })

      const session = createTestSession('Hi')
      await runner.run(myAgent, session)

      expect(order).toEqual(['runner:before', 'agent:before', 'agent:after', 'runner:after'])
    })

    it('runner hook can short-circuit agent execution', async () => {
      const order: string[] = []

      const runnerHook: Hook = {
        beforeAgent: () => {
          order.push('runner:before')
          return 'Blocked by runner hook'
        },
      }

      const agentHook: Hook = {
        beforeAgent: () => {
          order.push('agent:before')
        },
      }

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Should not see this' }],
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        hooks: [agentHook],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
        hooks: [runnerHook],
      })

      const session = createTestSession('Hi')
      const result = await runner.run(myAgent, session)

      expect(result.status).toBe('completed')
      expect(order).toEqual(['runner:before'])
      expect(mockAdapter.stepCalls.length).toBe(0)
    })
  })

  describe('Multiple hooks on agent', () => {
    it('integrates multiple hooks in array order', async () => {
      const order: string[] = []

      const hook1: Hook = {
        beforeAgent: () => {
          order.push('hook1:before')
        },
        afterAgent: () => {
          order.push('hook1:after')
        },
      }

      const hook2: Hook = {
        beforeAgent: () => {
          order.push('hook2:before')
        },
        afterAgent: () => {
          order.push('hook2:after')
        },
      }

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Test' }],
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        hooks: [hook1, hook2],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = createTestSession('Hi')
      await runner.run(myAgent, session)

      expect(order).toEqual(['hook1:before', 'hook2:before', 'hook2:after', 'hook1:after'])
    })
  })
})
