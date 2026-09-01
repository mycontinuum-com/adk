import { EventType } from '@ag-ui/core'

import { AgUIAdapter } from './adapter'

const base = {
  id: 'evt_1',
  createdAt: Date.now(),
  invocationId: 'inv_1',
  agentName: 'test',
}

describe('AgUIAdapter', () => {
  describe('transform', () => {
    it('transforms thought_delta to REASONING events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events1 = adapter.transform({
        ...base,
        type: 'thought_delta',
        delta: 'Hello',
        text: 'Hello',
      })
      expect(events1).toHaveLength(3)
      expect(events1[0]).toMatchObject({
        type: EventType.REASONING_START,
      })
      expect(events1[0]).toHaveProperty('messageId')
      expect(events1[1]).toMatchObject({
        type: EventType.REASONING_MESSAGE_START,
        role: 'reasoning',
      })
      expect(events1[1]).toHaveProperty('messageId')
      expect(events1[2]).toMatchObject({
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: 'Hello',
      })
      expect(events1[2]).toHaveProperty('messageId')

      const events2 = adapter.transform({
        ...base,
        type: 'thought_delta',
        delta: ' world',
        text: 'Hello world',
      })
      expect(events2).toHaveLength(1)
      expect(events2[0]).toMatchObject({
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: ' world',
      })

      const events3 = adapter.transform({
        ...base,
        type: 'thought',
        text: 'Hello world',
      })
      expect(events3).toHaveLength(2)
      expect(events3[0]).toMatchObject({
        type: EventType.REASONING_MESSAGE_END,
      })
      expect(events3[1]).toMatchObject({
        type: EventType.REASONING_END,
      })
    })

    it('uses consistent messageIds across reasoning events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const startEvents = adapter.transform({
        ...base,
        type: 'thought_delta',
        delta: 'thinking',
        text: 'thinking',
      })

      const phaseId = (startEvents[0] as Record<string, unknown>).messageId
      const msgId = (startEvents[1] as Record<string, unknown>).messageId
      expect(phaseId).toMatch(/^reasoning_/)
      expect(msgId).toMatch(/^reasoning_msg_/)
      expect((startEvents[2] as Record<string, unknown>).messageId).toBe(msgId)

      const endEvents = adapter.transform({
        ...base,
        type: 'thought',
        text: 'thinking',
      })
      expect((endEvents[0] as Record<string, unknown>).messageId).toBe(msgId)
      expect((endEvents[1] as Record<string, unknown>).messageId).toBe(phaseId)
    })

    it('transforms assistant_delta to TEXT_MESSAGE events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events1 = adapter.transform({
        ...base,
        type: 'assistant_delta',
        delta: 'Hi',
        text: 'Hi',
      })
      expect(events1).toHaveLength(2)
      expect(events1[0]).toMatchObject({
        type: EventType.TEXT_MESSAGE_START,
        role: 'assistant',
      })
      expect(events1[1]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: 'Hi',
      })

      const events2 = adapter.transform({
        ...base,
        type: 'assistant',
        text: 'Hi',
      })
      expect(events2).toHaveLength(1)
      expect(events2[0]).toMatchObject({ type: EventType.TEXT_MESSAGE_END })
    })

    it('closes reasoning when assistant starts', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      adapter.transform({
        ...base,
        type: 'thought_delta',
        delta: 'thinking',
        text: 'thinking',
      })
      const events = adapter.transform({
        ...base,
        type: 'assistant_delta',
        delta: 'response',
        text: 'response',
      })

      expect(events[0]).toMatchObject({
        type: EventType.REASONING_MESSAGE_END,
      })
      expect(events[1]).toMatchObject({
        type: EventType.REASONING_END,
      })
      expect(events[2]).toMatchObject({ type: EventType.TEXT_MESSAGE_START })
    })

    it('transforms tool_call events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events = adapter.transform({
        ...base,
        type: 'tool_call',
        callId: 'call_1',
        name: 'search',
        args: { query: 'test' },
      })

      expect(events).toHaveLength(3)
      expect(events[0]).toMatchObject({
        type: EventType.TOOL_CALL_START,
        toolCallId: 'call_1',
        toolCallName: 'search',
      })
      expect(events[1]).toMatchObject({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: 'call_1',
        delta: '{"query":"test"}',
      })
      expect(events[2]).toMatchObject({
        type: EventType.TOOL_CALL_END,
        toolCallId: 'call_1',
      })
    })

    it('omits TOOL_CALL_END for yielding tools', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events = adapter.transform({
        ...base,
        type: 'tool_call',
        callId: 'call_1',
        name: 'ask',
        args: { question: 'test' },
        yields: true,
      })

      expect(events).toHaveLength(2)
      expect(events.find((e) => e.type === EventType.TOOL_CALL_END)).toBeUndefined()
    })

    it('transforms tool_result events with role: tool', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events = adapter.transform({
        ...base,
        type: 'tool_result',
        callId: 'call_1',
        name: 'search',
        result: { found: true },
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: 'call_1',
        role: 'tool',
        content: '{"found":true}',
      })
    })

    it('transforms state_change events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events = adapter.transform({
        type: 'state_change',
        id: 'evt_1',
        createdAt: Date.now(),
        scope: 'session',
        source: 'mutation',
        changes: [
          { key: 'status', oldValue: undefined, newValue: 'active' },
          { key: 'count', oldValue: 1, newValue: 2 },
        ],
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: EventType.STATE_DELTA,
        delta: [
          { op: 'add', path: '/session/status', value: 'active' },
          { op: 'replace', path: '/session/count', value: 2 },
        ],
      })
    })

    it('respects includeReasoning: false option', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1', {
        includeReasoning: false,
      })

      const events1 = adapter.transform({
        ...base,
        type: 'thought_delta',
        delta: 'thinking',
        text: 'thinking',
      })
      expect(events1).toHaveLength(0)

      const events2 = adapter.transform({
        ...base,
        type: 'thought',
        text: 'thinking',
      })
      expect(events2).toHaveLength(0)
    })

    it('includes timestamp from createdAt', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')
      const now = Date.now()

      const events = adapter.transform({
        ...base,
        createdAt: now,
        type: 'assistant_delta',
        delta: 'Hi',
        text: 'Hi',
      })

      expect(events[0]).toHaveProperty('timestamp', now)
      expect(events[1]).toHaveProperty('timestamp', now)
    })

    it('includes rawEvent when includeRawEvents is true', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1', {
        includeRawEvents: true,
      })
      const event = {
        ...base,
        type: 'assistant_delta' as const,
        delta: 'Hi',
        text: 'Hi',
      }

      const events = adapter.transform(event)

      expect(events[0]).toHaveProperty('rawEvent', event)
    })

    it('transforms invocation_start to STEP_STARTED when includeSteps is true', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1', {
        includeSteps: true,
      })

      const events = adapter.transform({
        ...base,
        type: 'invocation_start',
        kind: 'agent',
        agentName: 'myAgent',
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: EventType.STEP_STARTED,
        stepName: 'myAgent',
      })
    })

    it('transforms invocation_end to STEP_FINISHED when includeSteps is true', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1', {
        includeSteps: true,
      })

      const events = adapter.transform({
        ...base,
        type: 'invocation_end',
        kind: 'agent',
        reason: 'completed',
        agentName: 'myAgent',
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: EventType.STEP_FINISHED,
        stepName: 'myAgent',
      })
    })

    it('ignores invocation events when includeSteps is false', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1', {
        includeSteps: false,
      })

      const events1 = adapter.transform({
        ...base,
        type: 'invocation_start',
        kind: 'agent',
        agentName: 'myAgent',
      })
      const events2 = adapter.transform({
        ...base,
        type: 'invocation_end',
        kind: 'agent',
        reason: 'completed',
        agentName: 'myAgent',
      })

      expect(events1).toHaveLength(0)
      expect(events2).toHaveLength(0)
    })
  })

  describe('yield transformers', () => {
    it('uses custom yield transformer when provided', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1', {
        yieldTransformers: {
          ask: (event) => ({
            type: EventType.CUSTOM,
            name: 'QUESTION',
            value: {
              callId: event.callId,
              question: (event.args as { question: string }).question,
            },
          }),
        },
      })

      const events = adapter.transform({
        ...base,
        type: 'tool_yield',
        callId: 'call_1',
        name: 'ask',
        args: { question: 'How are you?' },
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: 'QUESTION',
        value: { callId: 'call_1', question: 'How are you?' },
      })
    })

    it('uses default TOOL_YIELD for unknown tools', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events = adapter.transform({
        ...base,
        type: 'tool_yield',
        callId: 'call_1',
        name: 'unknown_tool',
        args: { foo: 'bar' },
      })

      expect(events[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: 'TOOL_YIELD',
        value: {
          callId: 'call_1',
          toolName: 'unknown_tool',
          args: { foo: 'bar' },
        },
      })
    })
  })

  describe('lifecycle methods', () => {
    it('generates run lifecycle events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      expect(adapter.runStarted()).toMatchObject({
        type: EventType.RUN_STARTED,
        threadId: 'thread_1',
        runId: 'run_1',
      })

      expect(adapter.runFinished()).toMatchObject({
        type: EventType.RUN_FINISHED,
        threadId: 'thread_1',
        runId: 'run_1',
      })

      expect(adapter.runFinished({ data: 'result' })).toMatchObject({
        type: EventType.RUN_FINISHED,
        threadId: 'thread_1',
        runId: 'run_1',
        result: { data: 'result' },
      })

      expect(adapter.runError('Something failed')).toMatchObject({
        type: EventType.RUN_ERROR,
        message: 'Something failed',
      })

      expect(adapter.runError('Something failed', 'ERR_001')).toMatchObject({
        type: EventType.RUN_ERROR,
        message: 'Something failed',
        code: 'ERR_001',
      })
    })

    it('generates state snapshot events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      expect(adapter.stateSnapshot({ status: 'active', count: 5 })).toMatchObject({
        type: EventType.STATE_SNAPSHOT,
        snapshot: { status: 'active', count: 5 },
      })
    })

    it('generates interrupt events for yields', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      const events = adapter.runInterrupted({
        id: 'call_123',
        reason: 'tool_yield',
        payload: { question: 'Confirm?' },
      })

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: 'RUN_INTERRUPTED',
        value: {
          threadId: 'thread_1',
          runId: 'run_1',
          id: 'call_123',
          reason: 'tool_yield',
          payload: { question: 'Confirm?' },
        },
      })
      expect(events[1]).toMatchObject({
        type: EventType.RUN_FINISHED,
        threadId: 'thread_1',
        runId: 'run_1',
      })
    })

    it('generates custom events', () => {
      const adapter = new AgUIAdapter('thread_1', 'run_1')

      expect(adapter.custom('COMPLETION', { result: 'done' })).toMatchObject({
        type: EventType.CUSTOM,
        name: 'COMPLETION',
        value: { result: 'done' },
      })
    })
  })
})
