/**
 * Coding Agent Tests
 *
 * Tests for the CodingAgent interface, mock agent, Claude Code agent, noop tool, and SDK message
 * mappers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import type { StreamEvent, ToolCallEvent } from '../../types/events'
import type { ClaudeSDK, SDKQueryOptions } from './claude-code/agent'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKRateLimitEvent,
} from './claude-code/types'
import type { MockResponse } from './types'

import { createClaudeCodeAgentWithSDK } from './claude-code'
import {
  mapAssistantMessage,
  mapUserMessage,
  mapPartialMessage,
  mapSystemMessage,
  mapResultToCodingResult,
  mapRateLimitEvent,
  extractModifiedFile,
  type MapperContext,
} from './claude-code/mappers'
import { createMockCodingAgent } from './mock'
import { createNoopTool } from './tool'

describe('CodingAgent', () => {
  describe('mock agent', () => {
    it('creates a mock agent with default options', () => {
      const agent = createMockCodingAgent()

      expect(agent.name).toBe('mock')
      expect(agent.description).toBeTruthy()
      expect(agent.schema).toBeDefined()
    })

    it('implements .run() that returns a CodingHandle', async () => {
      const agent = createMockCodingAgent({
        responses: [{ type: 'assistant', text: 'Hello!' }],
      })

      const handle = agent.run('Test task')

      // Should be async iterable
      expect(typeof handle[Symbol.asyncIterator]).toBe('function')

      // Should be thenable
      expect(typeof handle.then).toBe('function')

      // Should have send and abort
      expect(typeof handle.send).toBe('function')
      expect(typeof handle.abort).toBe('function')
    })

    it('streams events via for-await', async () => {
      const responses: MockResponse[] = [
        { type: 'assistant', text: 'Starting task...' },
        { type: 'tool_call', name: 'write', args: { path: 'test.txt' } },
        { type: 'tool_result', name: 'write', result: 'OK' },
        { type: 'assistant', text: 'Done!' },
      ]

      const agent = createMockCodingAgent({ responses })
      const handle = agent.run('Create test.txt')

      const events: StreamEvent[] = []
      for await (const event of handle) {
        events.push(event)
      }

      expect(events).toHaveLength(4)
      expect(events[0].type).toBe('assistant')
      expect(events[1].type).toBe('tool_call')
      expect(events[2].type).toBe('tool_result')
      expect(events[3].type).toBe('assistant')
    })

    it('resolves to CodingResult when awaited', async () => {
      const agent = createMockCodingAgent({
        responses: [{ type: 'assistant', text: 'Completed!' }],
      })

      const result = await agent.run('Test task')

      expect(result.status).toBe('completed')
      expect(result.sessionId).toBeTruthy()
      expect(result.output.text).toBe('Completed!')
      expect(result.output.value?.modifiedFiles).toEqual([])
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('tracks modified files from tool calls', async () => {
      const agent = createMockCodingAgent({
        responses: [
          { type: 'tool_call', name: 'write', args: { path: 'file1.ts' } },
          { type: 'tool_call', name: 'edit', args: { file_path: 'file2.ts' } },
          { type: 'tool_call', name: 'read', args: { path: 'file3.ts' } }, // Read, not write
        ],
      })

      const result = await agent.run('Modify files')

      expect(result.output.value?.modifiedFiles).toContain('file1.ts')
      expect(result.output.value?.modifiedFiles).toContain('file2.ts')
      // Note: read is not tracked as a write, so it may or may not be included
    })

    it('supports abort via handle.abort()', async () => {
      const agent = createMockCodingAgent({
        responses: [
          { type: 'assistant', text: 'Step 1' },
          { type: 'assistant', text: 'Step 2' },
          { type: 'assistant', text: 'Step 3' },
        ],
        delayMs: 50,
      })

      const handle = agent.run('Long task')

      // Abort after first event
      const events: StreamEvent[] = []
      for await (const event of handle) {
        events.push(event)
        handle.abort()
      }

      const result = await handle
      expect(result.status).toBe('aborted')
    })

    it('supports abort via send({ type: "abort" })', async () => {
      const agent = createMockCodingAgent({
        responses: [{ type: 'assistant', text: 'Working...' }],
        delayMs: 50,
      })

      const handle = agent.run('Task')
      handle.send({ type: 'abort' })

      const result = await handle
      expect(result.status).toBe('aborted')
    })

    it('supports abort via AbortSignal', async () => {
      const abortController = new AbortController()

      const agent = createMockCodingAgent({
        responses: [{ type: 'assistant', text: 'Working...' }],
        delayMs: 50,
      })

      const handle = agent.run({
        task: 'Task',
        signal: abortController.signal,
      })

      abortController.abort()

      const result = await handle
      expect(result.status).toBe('aborted')
    })

    it('simulates errors when configured', async () => {
      const agent = createMockCodingAgent({
        responses: [{ type: 'assistant', text: 'Starting...' }],
        simulateError: {
          after: 0,
          message: 'Simulated failure',
          code: 'sdk_error',
        },
      })

      const handle = agent.run('Failing task')

      // Streaming should throw
      const consumeStream = async () => {
        for await (const _ of handle) {
          // consume
        }
      }
      await expect(consumeStream()).rejects.toThrow('Simulated failure')

      // Result should have error
      const result = await handle
      expect(result.status).toBe('error')
      expect(result.error?.message).toBe('Simulated failure')
      expect(result.error?.code).toBe('sdk_error')
    })

    it('simulates immediate errors', async () => {
      const agent = createMockCodingAgent({
        simulateError: {
          after: 'immediately',
          message: 'Immediate failure',
        },
      })

      const handle = agent.run('Will fail')

      const consumeStream = async () => {
        for await (const _ of handle) {
          // consume
        }
      }
      await expect(consumeStream()).rejects.toThrow('Immediate failure')
    })

    it('emits artifact events', async () => {
      const agent = createMockCodingAgent({
        responses: [{ type: 'assistant', text: 'Creating artifact...' }],
        artifacts: [
          { name: 'summary.md', content: '# Summary\nDone!' },
          { name: 'data.json', content: '{"status":"ok"}' },
        ],
      })

      const events: StreamEvent[] = []
      for await (const event of agent.run('Create artifacts')) {
        events.push(event)
      }

      const artifactEvents = events.filter((e) => e.type === 'artifact_update')
      expect(artifactEvents).toHaveLength(2)
      expect(artifactEvents[0]).toMatchObject({
        type: 'artifact_update',
        name: 'summary.md',
      })
      expect(artifactEvents[1]).toMatchObject({
        type: 'artifact_update',
        name: 'data.json',
      })
    })

    it('supports custom result override', async () => {
      const agent = createMockCodingAgent({
        result: {
          status: 'max_turns',
          sessionId: 'custom-session-123',
        },
      })

      const result = await agent.run('Task')

      expect(result.status).toBe('max_turns')
      expect(result.sessionId).toBe('custom-session-123')
    })

    it('supports streaming delay for realistic simulation', async () => {
      const agent = createMockCodingAgent({
        responses: [
          { type: 'assistant', text: 'One' },
          { type: 'assistant', text: 'Two' },
        ],
        delayMs: 10,
      })

      const startTime = performance.now()

      for await (const _ of agent.run('Task')) {
        // consume
      }

      const elapsed = performance.now() - startTime
      // Two 10 ms delays. A Node timer may fire up to a millisecond early and Date.now() rounds, so
      // the floor allows one millisecond per delay (CI measured 19 for 20).
      expect(elapsed).toBeGreaterThanOrEqual(18)
    })

    describe('.execute() for tool interface', () => {
      it('works as a FunctionTool', async () => {
        const agent = createMockCodingAgent({
          responses: [{ type: 'assistant', text: 'Tool result' }],
        })

        // Simulate being called as a tool
        const result = await agent.execute({
          args: { task: 'Tool task' },
          signal: new AbortController().signal,
        } as any)

        expect(result.status).toBe('completed')
        expect(result.output.text).toBe('Tool result')
      })

      it('passes sessionId from args', async () => {
        const agent = createMockCodingAgent()

        const result = await agent.execute({
          args: { task: 'Resume task', sessionId: 'existing-session' },
          signal: new AbortController().signal,
        } as any)

        expect(result.sessionId).toBe('existing-session')
      })
    })

    describe('.asTool() customization', () => {
      it('creates a tool with custom name and description', () => {
        const agent = createMockCodingAgent()

        const tool = agent.asTool({
          name: 'custom_coder',
          description: 'Custom description',
        })

        expect(tool.name).toBe('custom_coder')
        expect(tool.description).toBe('Custom description')
        expect(tool.schema).toBe(agent.schema)
        expect(typeof tool.execute).toBe('function')
      })

      it('uses default values when not customized', () => {
        const agent = createMockCodingAgent()
        const tool = agent.asTool()

        expect(tool.name).toBe(agent.name)
        expect(tool.description).toBe(agent.description)
      })
    })
  })

  describe('Claude Code agent', () => {
    let mockSDK: ClaudeSDK
    let queryMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      queryMock = vi.fn<(...args: unknown[]) => unknown>()
      mockSDK = { query: queryMock }
    })

    function createMockMessages(messages: Partial<SDKMessage>[]): AsyncGenerator<SDKMessage> {
      return (async function* () {
        for (const msg of messages) {
          yield msg as SDKMessage
        }
      })()
    }

    it('creates an agent with the provided workspace', () => {
      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/test/repo',
      })

      expect(agent.name).toBe('claude-code')
      expect(agent.description).toBeTruthy()
    })

    it('streams assistant messages as events', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'assistant',
            uuid: 'msg-1',
            message: {
              content: [{ type: 'text', text: 'Hello, I am analyzing...' }],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            session_id: 'session-123',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const events: StreamEvent[] = []
      for await (const event of agent.run('Fix the bug')) {
        events.push(event)
      }

      expect(events.length).toBeGreaterThan(0)
      const assistantEvent = events.find((e) => e.type === 'assistant')
      expect(assistantEvent).toBeDefined()
    })

    it('maps tool_use content to tool_call events', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'assistant',
            uuid: 'msg-1',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-call-1',
                  name: 'Read',
                  input: { path: '/file.ts' },
                },
              ],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            session_id: 'session-123',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const events: StreamEvent[] = []
      for await (const event of agent.run('Read the file')) {
        events.push(event)
      }

      const toolCallEvent = events.find((e) => e.type === 'tool_call')
      expect(toolCallEvent).toBeDefined()
      expect(toolCallEvent).toMatchObject({
        type: 'tool_call',
        callId: 'tool-call-1',
        name: 'Read',
      })
    })

    it('maps result message to CodingResult', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'result',
            subtype: 'success',
            result: 'Task completed successfully',
            session_id: 'session-abc',
            total_cost_usd: 0.05,
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 100,
            },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const result = await agent.run('Complete the task')

      expect(result.status).toBe('completed')
      expect(result.sessionId).toBeTruthy()
      expect(result.output.text).toBe('Task completed successfully')
      expect(result.usage?.totalInputTokens).toBe(1000)
      expect(result.usage?.totalOutputTokens).toBe(500)
      expect(result.usage?.cost?.totalCost).toBe(0.05)
    })

    it('handles error results', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'result',
            subtype: 'error_during_execution',
            errors: [{ message: 'Something went wrong' }],
            session_id: 'session-err',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const result = await agent.run('Failing task')

      expect(result.status).toBe('error')
      expect(result.error?.message).toContain('Something went wrong')
    })

    it('handles max_turns result', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'result',
            subtype: 'error_max_turns',
            session_id: 'session-max',
            total_cost_usd: 0.1,
            usage: { input_tokens: 5000, output_tokens: 2000 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const result = await agent.run('Complex task')

      expect(result.status).toBe('max_turns')
    })

    it('passes configuration to SDK query', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            session_id: 'session-123',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/my/repo',
        config: {
          model: 'claude-sonnet-4-20250514',
          maxTurns: 10,
          permissionMode: 'bypassPermissions',
          thinking: { type: 'enabled', budgetTokens: 5000 },
        },
      })

      await agent.run('Test')

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Test',
          options: expect.objectContaining({
            cwd: '/my/repo',
            model: 'claude-sonnet-4-20250514',
            maxTurns: 10,
            permissionMode: 'bypassPermissions',
            thinking: { type: 'enabled', budgetTokens: 5000 },
          }),
        }),
      )
    })

    it('tracks modified files from Write/Edit tool calls', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'assistant',
            uuid: 'msg-1',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'write-1',
                  name: 'Write',
                  input: { file_path: '/repo/new-file.ts', content: '...' },
                },
              ],
            },
          },
          {
            type: 'assistant',
            uuid: 'msg-2',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'edit-1',
                  name: 'Edit',
                  input: { file_path: '/repo/existing.ts', old_string: 'a', new_string: 'b' },
                },
              ],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            session_id: 'session-123',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const result = await agent.run('Modify files')

      expect(result.output.value?.modifiedFiles).toContain('/repo/new-file.ts')
      expect(result.output.value?.modifiedFiles).toContain('/repo/existing.ts')
    })

    it('handles abort signal', async () => {
      const abortController = new AbortController()

      queryMock.mockImplementation(async function* (params: {
        prompt: string
        options?: SDKQueryOptions
      }) {
        for (let i = 0; i < 10; i++) {
          if (params.options?.abortController?.signal.aborted) {
            return
          }
          yield {
            type: 'assistant',
            uuid: `msg-${i}`,
            message: { content: [{ type: 'text', text: `Step ${i}` }] },
          } as SDKMessage
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      })

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const handle = agent.run({
        task: 'Long task',
        signal: abortController.signal,
      })

      // Start consuming events
      const events: StreamEvent[] = []
      const consumePromise = (async () => {
        for await (const event of handle) {
          events.push(event)
          if (events.length >= 2) {
            abortController.abort()
          }
        }
      })()

      await consumePromise
      const result = await handle

      expect(result.status).toBe('aborted')
    })

    describe('.execute() for tool interface', () => {
      it('works as a FunctionTool', async () => {
        queryMock.mockReturnValue(
          createMockMessages([
            {
              type: 'result',
              subtype: 'success',
              result: 'Tool completed',
              session_id: 'session-123',
              total_cost_usd: 0.01,
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          ]),
        )

        const agent = createClaudeCodeAgentWithSDK(mockSDK, {
          workspace: '/repo',
        })

        const result = await agent.execute({
          args: { task: 'Tool task' },
          signal: new AbortController().signal,
        } as any)

        expect(result.status).toBe('completed')
        expect(result.output.text).toBe('Tool completed')
      })
    })

    it('resumes session when sessionId is provided', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'result',
            subtype: 'success',
            result: 'Resumed',
            session_id: 'existing-session',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      await agent.run({
        task: 'Continue task',
        sessionId: 'existing-session',
      })

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Continue task',
          options: expect.objectContaining({
            resume: 'existing-session',
          }),
        }),
      )
    })

    it('maps thinking content to thought events', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'assistant',
            uuid: 'msg-1',
            message: {
              content: [
                { type: 'thinking', thinking: 'Let me analyze this...' },
                { type: 'text', text: 'Here is my response' },
              ],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            session_id: 'session-123',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const events: StreamEvent[] = []
      for await (const event of agent.run('Think about this')) {
        events.push(event)
      }

      const thoughtEvent = events.find((e) => e.type === 'thought')
      expect(thoughtEvent).toBeDefined()
      expect((thoughtEvent as any).text).toBe('Let me analyze this...')
    })

    it('maps partial messages to delta events', async () => {
      queryMock.mockReturnValue(
        createMockMessages([
          {
            type: 'partial_assistant',
            uuid: 'msg-1',
            delta: { type: 'text_delta', text: 'Hello' },
          },
          {
            type: 'partial_assistant',
            uuid: 'msg-1',
            delta: { type: 'text_delta', text: ' world' },
          },
          {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            session_id: 'session-123',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        ]),
      )

      const agent = createClaudeCodeAgentWithSDK(mockSDK, {
        workspace: '/repo',
      })

      const events: StreamEvent[] = []
      for await (const event of agent.run('Stream response')) {
        events.push(event)
      }

      const deltaEvents = events.filter((e) => e.type === 'assistant_delta')
      expect(deltaEvents.length).toBe(2)
      expect((deltaEvents[0] as any).delta).toBe('Hello')
      expect((deltaEvents[1] as any).delta).toBe(' world')
    })
  })

  describe('noop tool', () => {
    it('creates a tool with default options', () => {
      const tool = createNoopTool()

      expect(tool.name).toBe('coding')
      expect(tool.description).toBe('A no-op coding tool for testing.')
      expect(tool.schema).toBeDefined()
    })

    it('creates a tool with custom name and description', () => {
      const tool = createNoopTool({
        name: 'custom_coding',
        description: 'Custom noop tool',
      })

      expect(tool.name).toBe('custom_coding')
      expect(tool.description).toBe('Custom noop tool')
    })

    it('returns completed CodingResult on execute', async () => {
      const tool = createNoopTool()

      const result = await tool.execute({
        args: { task: 'Do nothing' },
        signal: new AbortController().signal,
      } as any)

      expect(result.status).toBe('completed')
      expect(result.sessionId).toMatch(/^noop-/)
      expect(result.output.text).toBe('No-op execution completed.')
      expect(result.output.value?.modifiedFiles).toEqual([])
      expect(result.durationMs).toBe(0)
      expect(result.usage?.totalInputTokens).toBe(0)
      expect(result.usage?.totalOutputTokens).toBe(0)
    })
  })

  describe('SDK message mappers', () => {
    let ctx: MapperContext

    beforeEach(() => {
      ctx = {
        invocationId: 'test-inv',
        agentName: 'test-agent',
        processId: 'test-proc',
        accumulatedText: '',
        accumulatedThinking: '',
      }
    })

    describe('mapAssistantMessage', () => {
      it('maps text content to assistant events', () => {
        const msg: SDKAssistantMessage = {
          type: 'assistant',
          uuid: 'msg-1',
          message: {
            content: [{ type: 'text', text: 'Hello world' }],
          },
        }

        const events = [...mapAssistantMessage(msg, ctx)]

        expect(events).toHaveLength(1)
        expect(events[0].type).toBe('assistant')
        expect((events[0] as any).text).toBe('Hello world')
        expect(ctx.accumulatedText).toBe('Hello world')
      })

      it('maps tool_use content to tool_call events', () => {
        const msg: SDKAssistantMessage = {
          type: 'assistant',
          uuid: 'msg-1',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'call-1',
                name: 'Read',
                input: { path: '/test.ts' },
              },
            ],
          },
        }

        const events = [...mapAssistantMessage(msg, ctx)]

        expect(events).toHaveLength(1)
        expect(events[0].type).toBe('tool_call')
        expect((events[0] as any).callId).toBe('call-1')
        expect((events[0] as any).name).toBe('Read')
        expect((events[0] as any).args).toEqual({ path: '/test.ts' })
      })

      it('maps thinking content to thought events', () => {
        const msg: SDKAssistantMessage = {
          type: 'assistant',
          uuid: 'msg-1',
          message: {
            content: [{ type: 'thinking', thinking: 'Let me think...' }],
          },
        }

        const events = [...mapAssistantMessage(msg, ctx)]

        expect(events).toHaveLength(1)
        expect(events[0].type).toBe('thought')
        expect((events[0] as any).text).toBe('Let me think...')
        expect(ctx.accumulatedThinking).toBe('Let me think...')
      })

      it('maps multiple content blocks to multiple events', () => {
        const msg: SDKAssistantMessage = {
          type: 'assistant',
          uuid: 'msg-1',
          message: {
            content: [
              { type: 'thinking', thinking: 'Thinking...' },
              { type: 'text', text: 'Response' },
              { type: 'tool_use', id: 'call-1', name: 'Write', input: {} },
            ],
          },
        }

        const events = [...mapAssistantMessage(msg, ctx)]

        expect(events).toHaveLength(3)
        expect(events[0].type).toBe('thought')
        expect(events[1].type).toBe('assistant')
        expect(events[2].type).toBe('tool_call')
      })
    })

    describe('mapUserMessage', () => {
      it('maps tool_result to tool_result events', () => {
        const msg: SDKUserMessage = {
          type: 'user',
          uuid: 'msg-1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: 'Tool output',
              },
            ],
          },
        }

        const events = [...mapUserMessage(msg, ctx)]

        expect(events).toHaveLength(1)
        expect(events[0].type).toBe('tool_result')
        expect((events[0] as any).callId).toBe('call-1')
        expect((events[0] as any).result).toBe('Tool output')
      })

      it('maps error tool results correctly', () => {
        const msg: SDKUserMessage = {
          type: 'user',
          uuid: 'msg-1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: 'Error message',
                is_error: true,
              },
            ],
          },
        }

        const events = [...mapUserMessage(msg, ctx)]

        expect(events).toHaveLength(1)
        expect((events[0] as any).result).toBeUndefined()
        expect((events[0] as any).error).toBe('Error message')
      })

      it('does not emit events for string content', () => {
        const msg: SDKUserMessage = {
          type: 'user',
          uuid: 'msg-1',
          message: {
            content: 'User message',
          },
        }

        const events = [...mapUserMessage(msg, ctx)]

        expect(events).toHaveLength(0)
      })
    })

    describe('mapPartialMessage', () => {
      it('maps text_delta to assistant_delta', () => {
        const msg: SDKPartialAssistantMessage = {
          type: 'partial_assistant',
          uuid: 'msg-1',
          delta: { type: 'text_delta', text: 'Hello' },
        }

        const event = mapPartialMessage(msg, ctx)

        expect(event).not.toBeNull()
        expect(event!.type).toBe('assistant_delta')
        expect((event as any).delta).toBe('Hello')
        expect(ctx.accumulatedText).toBe('Hello')
      })

      it('maps thinking_delta to thought_delta', () => {
        const msg: SDKPartialAssistantMessage = {
          type: 'partial_assistant',
          uuid: 'msg-1',
          delta: { type: 'thinking_delta', thinking: 'Hmm...' },
        }

        const event = mapPartialMessage(msg, ctx)

        expect(event).not.toBeNull()
        expect(event!.type).toBe('thought_delta')
        expect((event as any).delta).toBe('Hmm...')
        expect(ctx.accumulatedThinking).toBe('Hmm...')
      })

      it('returns null for other delta types', () => {
        const msg: SDKPartialAssistantMessage = {
          type: 'partial_assistant',
          uuid: 'msg-1',
          delta: { type: 'input_json_delta' as any },
        }

        const event = mapPartialMessage(msg, ctx)

        expect(event).toBeNull()
      })
    })

    describe('mapSystemMessage', () => {
      it('maps init messages to system events', () => {
        const msg: SDKSystemMessage = {
          type: 'system',
          subtype: 'init',
          tools: ['Read', 'Write', 'Edit'],
          agents: [],
          mcp_servers: [],
          permissionMode: 'acceptEdits',
        }

        const event = mapSystemMessage(msg, ctx)

        expect(event).not.toBeNull()
        expect(event!.type).toBe('system')
        expect((event as any).text).toContain('3 tools')
      })

      it('returns null for non-init messages', () => {
        const msg: SDKSystemMessage = {
          type: 'system',
          subtype: 'api_key',
        }

        const event = mapSystemMessage(msg, ctx)

        expect(event).toBeNull()
      })
    })

    describe('mapResultToCodingResult', () => {
      it('maps success result correctly', () => {
        const msg: SDKResultMessage = {
          type: 'result',
          subtype: 'success',
          result: 'Task completed',
          session_id: 'session-123',
          total_cost_usd: 0.05,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 100,
          },
        }

        const result = mapResultToCodingResult(
          msg,
          'session-123',
          Date.now() - 1000,
          ['file1.ts', 'file2.ts'],
          'Accumulated text',
        )

        expect(result.status).toBe('completed')
        expect(result.sessionId).toBe('session-123')
        expect(result.output.text).toBe('Task completed')
        expect(result.output.value?.modifiedFiles).toEqual(['file1.ts', 'file2.ts'])
        expect(result.usage?.totalInputTokens).toBe(1000)
        expect(result.usage?.totalOutputTokens).toBe(500)
        expect(result.usage?.totalCachedTokens).toBe(100)
        expect(result.usage?.cost?.totalCost).toBe(0.05)
        expect(result.durationMs).toBeGreaterThan(0)
      })

      it('maps max_turns result correctly', () => {
        const msg: SDKResultMessage = {
          type: 'result',
          subtype: 'error_max_turns',
          session_id: 'session-123',
          total_cost_usd: 0.1,
          usage: { input_tokens: 5000, output_tokens: 2000 },
        }

        const result = mapResultToCodingResult(msg, 'session-123', Date.now(), [], '')

        expect(result.status).toBe('max_turns')
      })

      it('maps error result with error info', () => {
        const msg: SDKResultMessage = {
          type: 'result',
          subtype: 'error_during_execution',
          errors: [{ message: 'Something failed' }],
          session_id: 'session-123',
          total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 10 },
        }

        const result = mapResultToCodingResult(msg, 'session-123', Date.now(), [], '')

        expect(result.status).toBe('error')
        expect(result.error?.message).toBe('Something failed')
        expect(result.error?.code).toBe('sdk_error')
      })

      it('maps context exhausted error correctly', () => {
        const msg: SDKResultMessage = {
          type: 'result',
          subtype: 'error_during_execution',
          errors: [{ message: 'Context window exceeded' }],
          session_id: 'session-123',
          total_cost_usd: 0.1,
          usage: { input_tokens: 100000, output_tokens: 0 },
        }

        const result = mapResultToCodingResult(msg, 'session-123', Date.now(), [], '')

        expect(result.error?.code).toBe('context_exhausted')
      })
    })

    describe('mapRateLimitEvent', () => {
      it('returns shouldStop false for non-rejected events', () => {
        const event: SDKRateLimitEvent = {
          type: 'rate_limit',
          status: 'pending',
        }

        const result = mapRateLimitEvent(event, ctx)

        expect(result.shouldStop).toBe(false)
      })

      it('returns shouldStop true for rejected events', () => {
        const event: SDKRateLimitEvent = {
          type: 'rate_limit',
          status: 'rejected',
        }

        const result = mapRateLimitEvent(event, ctx)

        expect(result.shouldStop).toBe(true)
      })

      it('calculates retryAfter from reset_at', () => {
        const futureTime = new Date(Date.now() + 60000).toISOString()
        const event: SDKRateLimitEvent = {
          type: 'rate_limit',
          status: 'rejected',
          reset_at: futureTime,
        }

        const result = mapRateLimitEvent(event, ctx)

        expect(result.retryAfter).toBeGreaterThan(0)
        expect(result.retryAfter).toBeLessThanOrEqual(60)
      })
    })

    describe('extractModifiedFile', () => {
      it('extracts path from Write tool calls', () => {
        const event = {
          type: 'tool_call',
          name: 'Write',
          args: { file_path: '/repo/test.ts' },
        } as ToolCallEvent

        expect(extractModifiedFile(event)).toBe('/repo/test.ts')
      })

      it('extracts path from Edit tool calls', () => {
        const event = {
          type: 'tool_call',
          name: 'Edit',
          args: { file_path: '/repo/test.ts' },
        } as ToolCallEvent

        expect(extractModifiedFile(event)).toBe('/repo/test.ts')
      })

      it('handles different path argument names', () => {
        const event1 = {
          type: 'tool_call',
          name: 'write',
          args: { path: '/path1.ts' },
        } as ToolCallEvent
        const event2 = {
          type: 'tool_call',
          name: 'edit',
          args: { filePath: '/path2.ts' },
        } as ToolCallEvent
        const event3 = {
          type: 'tool_call',
          name: 'file_write',
          args: { file: '/path3.ts' },
        } as ToolCallEvent

        expect(extractModifiedFile(event1)).toBe('/path1.ts')
        expect(extractModifiedFile(event2)).toBe('/path2.ts')
        expect(extractModifiedFile(event3)).toBe('/path3.ts')
      })

      it('returns null for Read tool calls', () => {
        const event = {
          type: 'tool_call',
          name: 'Read',
          args: { path: '/repo/test.ts' },
        } as ToolCallEvent

        expect(extractModifiedFile(event)).toBeNull()
      })

      it('returns null for unknown tools', () => {
        const event = {
          type: 'tool_call',
          name: 'Bash',
          args: { command: 'ls' },
        } as ToolCallEvent

        expect(extractModifiedFile(event)).toBeNull()
      })
    })
  })
})
