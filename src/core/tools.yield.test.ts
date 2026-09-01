import { z } from 'zod'

import { agent } from '../agents'
import { adk } from '../api'
import { injectSystemMessage, includeHistory } from '../context'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter } from '../testing'
import { BaseRunner } from './index'

const app = adk()

describe('yielding tool lifecycle', () => {
  const service = sessionService(inMemoryStore())

  function createMockRunner(
    responses: Array<{
      text?: string
      toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
    }>,
  ) {
    const mockAdapter = new MockAdapter({ responses })
    return new BaseRunner({
      sessionService: service,
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    })
  }

  describe('gating tool (yieldSchema without execute)', () => {
    test('prepare runs before yield', async () => {
      const prepareCalls: Array<{ args: unknown }> = []

      const askTool = app.tool({
        name: 'ask',
        description: 'Ask a question',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        prepare: (ctx) => {
          prepareCalls.push({ args: ctx.args })
          ctx.state.pendingQuestion = ctx.args.question
          return ctx.args
        },
        finalize: (ctx) => ({
          question: ctx.args.question,
          answer: ctx.input!.answer,
        }),
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [askTool],
      })

      const runner = createMockRunner([
        { toolCalls: [{ name: 'ask', args: { question: 'How are you?' } }] },
      ])

      const session = new BaseSession('test', { id: 'test-1' })
      session.input.message('Start')

      const result = await runner.run(testAgent, session)

      expect(result.status).toBe('yielded_tool')
      expect(prepareCalls).toHaveLength(1)
      expect(prepareCalls[0].args).toEqual({ question: 'How are you?' })
      expect(session.state.pendingQuestion).toBe('How are you?')
    })

    test('finalize is called with user input on resume', async () => {
      const finalizeCalls: Array<{
        input: unknown
        args: unknown
      }> = []

      const askTool = app.tool({
        name: 'ask',
        description: 'Ask a question',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        finalize: (ctx) => {
          finalizeCalls.push({ input: ctx.input, args: ctx.args })
          return { question: ctx.args.question, answer: ctx.input!.answer }
        },
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [askTool],
      })

      const runner = createMockRunner([
        { toolCalls: [{ name: 'ask', args: { question: 'How are you?' } }] },
        { text: 'Great to hear!' },
      ])

      const session = new BaseSession('test', { id: 'test-2' })
      session.input.message('Start')

      const result1 = await runner.run(testAgent, session)
      expect(result1.status).toBe('yielded_tool')

      if (result1.status === 'yielded_tool') {
        session.input.tool({
          callId: result1.yieldedTools[0].callId,
          input: { answer: 'I am fine' },
        })
      }

      const result2 = await runner.run(testAgent, session)
      expect(result2.status).toBe('completed')

      expect(finalizeCalls).toHaveLength(1)
      expect(finalizeCalls[0].input).toEqual({ answer: 'I am fine' })
      expect(finalizeCalls[0].args).toEqual({ question: 'How are you?' })
    })

    test('full lifecycle: prepare -> yield -> finalize', async () => {
      const callOrder: string[] = []

      const askTool = app.tool({
        name: 'ask',
        description: 'Ask a question',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        prepare: (ctx) => {
          callOrder.push('prepare')
          return ctx.args
        },
        finalize: (ctx) => {
          callOrder.push('finalize')
          ctx.state.finalAnswer = ctx.input
          return { question: ctx.args.question, answer: ctx.input!.answer }
        },
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [askTool],
      })

      const runner = createMockRunner([
        { toolCalls: [{ name: 'ask', args: { question: 'How are you?' } }] },
        { text: 'Thanks!' },
      ])

      const session = new BaseSession('test', { id: 'test-3' })
      session.input.message('Start')

      await runner.run(testAgent, session)

      if (session.yieldedTools.length > 0) {
        session.input.tool({
          callId: session.yieldedTools[0].callId,
          input: { answer: 'Good' },
        })
      }

      await runner.run(testAgent, session)

      expect(callOrder).toEqual(['prepare', 'finalize'])
      expect(session.state.finalAnswer).toEqual({
        answer: 'Good',
      })
    })
  })

  describe('confirming tool (yieldSchema with execute)', () => {
    test('execute runs after yield with ctx.input available', async () => {
      const executeCalls: Array<{ args: unknown; input: unknown }> = []

      const approvalTool = app.tool({
        name: 'request_approval',
        description: 'Request approval for action',
        schema: z.object({ action: z.string() }),
        yieldSchema: z.object({ approved: z.boolean() }),
        execute: (ctx) => {
          executeCalls.push({ args: ctx.args, input: ctx.input })
          if (!ctx.input?.approved) {
            return { action: ctx.args.action, status: 'declined' }
          }
          return { action: ctx.args.action, status: 'approved' }
        },
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [approvalTool],
      })

      const runner = createMockRunner([
        {
          toolCalls: [{ name: 'request_approval', args: { action: 'delete_file' } }],
        },
        { text: 'Action approved!' },
      ])

      const session = new BaseSession('test', { id: 'test-4' })
      session.input.message('Delete the file')

      const result1 = await runner.run(testAgent, session)
      expect(result1.status).toBe('yielded_tool')
      expect(executeCalls).toHaveLength(0)

      if (result1.status === 'yielded_tool') {
        session.input.tool({
          callId: result1.yieldedTools[0].callId,
          input: { approved: true },
        })
      }

      const result2 = await runner.run(testAgent, session)
      expect(result2.status).toBe('completed')

      expect(executeCalls).toHaveLength(1)
      expect(executeCalls[0].input).toEqual({ approved: true })
      expect(executeCalls[0].args).toEqual({ action: 'delete_file' })
    })

    test('full lifecycle: prepare -> yield -> execute -> finalize', async () => {
      const callOrder: string[] = []
      let finalResult: unknown

      const approvalTool = app.tool({
        name: 'request_approval',
        description: 'Request approval',
        schema: z.object({ action: z.string() }),
        yieldSchema: z.object({
          approved: z.boolean(),
          notes: z.string().optional(),
        }),
        prepare: (ctx) => {
          callOrder.push('prepare')
          ctx.state.pendingAction = ctx.args.action
          return ctx.args
        },
        execute: (ctx) => {
          callOrder.push('execute')
          return {
            action: ctx.args.action,
            performedAt: Date.now(),
            approved: ctx.input?.approved,
          }
        },
        finalize: (ctx) => {
          callOrder.push('finalize')
          ctx.state.pendingAction = undefined
          ctx.state.lastApproval = ctx.result
          finalResult = ctx.result
          return ctx.result
        },
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [approvalTool],
      })

      const runner = createMockRunner([
        {
          toolCalls: [{ name: 'request_approval', args: { action: 'deploy' } }],
        },
        { text: 'Deployed successfully!' },
      ])

      const session = new BaseSession('test', { id: 'test-5' })
      session.input.message('Deploy to production')

      await runner.run(testAgent, session)
      expect(callOrder).toEqual(['prepare'])

      if (session.yieldedTools.length > 0) {
        session.input.tool({
          callId: session.yieldedTools[0].callId,
          input: { approved: true, notes: 'Looks good' },
        })
      }

      await runner.run(testAgent, session)

      expect(callOrder).toEqual(['prepare', 'execute', 'finalize'])
      expect(session.state.pendingAction).toBeUndefined()
      expect(finalResult).toMatchObject({
        action: 'deploy',
        approved: true,
      })
    })
  })

  describe('backward compatibility', () => {
    test('non-yielding tools work unchanged', async () => {
      const normalTool = app.tool({
        name: 'calculate',
        description: 'Calculate',
        schema: z.object({ expr: z.string() }),
        // oxlint-disable-next-line eslint(no-eval)
        execute: (ctx) => ({ result: eval(ctx.args.expr) }),
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [normalTool],
      })

      const runner = createMockRunner([
        { toolCalls: [{ name: 'calculate', args: { expr: '2 + 2' } }] },
        { text: 'The answer is 4' },
      ])

      const session = new BaseSession('test', { id: 'test-7' })
      session.input.message('What is 2 + 2?')

      const result = await runner.run(testAgent, session)
      expect(result.status).toBe('completed')
    })
  })

  describe('input validation', () => {
    test('invalid input results in error tool result', async () => {
      const askTool = app.tool({
        name: 'ask',
        description: 'Ask',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        finalize: (ctx) => ctx.input,
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [askTool],
      })

      const runner = createMockRunner([
        { toolCalls: [{ name: 'ask', args: { question: 'Test?' } }] },
        { text: 'Error handled' },
      ])

      const session = new BaseSession('test', { id: 'test-validation' })
      session.input.message('Start')

      await runner.run(testAgent, session)

      if (session.yieldedTools.length > 0) {
        session.input.tool({
          callId: session.yieldedTools[0].callId,
          input: { wrongField: 123 },
        })
      }

      await runner.run(testAgent, session)

      const toolResults = session.events.filter((e) => e.type === 'tool_result')
      const errorResult = toolResults.find((e) => 'error' in e && e.error)
      expect(errorResult).toBeDefined()
    })
  })

  describe('invalid tool args for yielding tool', () => {
    test('returns error tool_result instead of silently hanging', async () => {
      const approvalTool = app.tool({
        name: 'request_approval',
        description: 'Request approval',
        schema: z.object({
          action: z.string(),
          confirm: z.boolean().nullable(),
        }),
        yieldSchema: z.object({ approved: z.boolean() }),
        execute: (ctx) => {
          return { status: ctx.input?.approved ? 'approved' : 'declined' }
        },
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [approvalTool],
      })

      // LLM sends "null" (string) instead of null for a boolean field —
      // this causes safeParse to fail. Previously, this silently hung.
      const runner = createMockRunner([
        {
          toolCalls: [
            {
              name: 'request_approval',
              args: { action: 'delete_file', confirm: 'null' },
            },
          ],
        },
        { text: 'Retrying with correct args' },
      ])

      const session = new BaseSession('test', {
        id: 'test-invalid-yield-args',
      })
      session.input.message('Delete the file')

      const result = await runner.run(testAgent, session)

      // Should NOT be 'yielded_tool' — the args were invalid, so no yield was created.
      // The error should have been fed back as a tool_result so the LLM can retry.
      expect(result.status).not.toBe('yielded_tool')

      // Should have a tool_result with an error message
      const toolResults = session.events.filter((e) => e.type === 'tool_result')
      const errorResult = toolResults.find((e) => 'error' in e && e.error)
      expect(errorResult).toBeDefined()
      expect((errorResult as any).error).toContain('Invalid arguments')
    })

    test('valid yielding tool still works after invalid args fix', async () => {
      const approvalTool = app.tool({
        name: 'request_approval',
        description: 'Request approval',
        schema: z.object({
          action: z.string(),
          confirm: z.boolean().nullable(),
        }),
        yieldSchema: z.object({ approved: z.boolean() }),
        execute: (ctx) => {
          return { status: ctx.input?.approved ? 'approved' : 'declined' }
        },
      })

      const testAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [approvalTool],
      })

      // Valid args — should yield correctly
      const runner = createMockRunner([
        {
          toolCalls: [
            {
              name: 'request_approval',
              args: { action: 'delete_file', confirm: null },
            },
          ],
        },
        { text: 'Approved!' },
      ])

      const session = new BaseSession('test', { id: 'test-valid-yield-args' })
      session.input.message('Delete the file')

      const result = await runner.run(testAgent, session)
      expect(result.status).toBe('yielded_tool')

      if (result.status === 'yielded_tool') {
        expect(result.yieldedTools).toHaveLength(1)
        expect(result.yieldedTools[0].name).toBe('request_approval')
      }
    })
  })
})
