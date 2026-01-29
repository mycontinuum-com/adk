import { z } from 'zod';
import { agent, step, sequence, loop } from '../agents';
import { tool } from '../core';
import { openai } from '../providers';
import { injectSystemMessage, includeHistory } from '../context';
import { MockAdapter } from '../testing';
import type { ToolResultEvent } from '../types';
import {
  EvalRunner,
  createEvalRunner,
  EvalSessionService,
  withStateChange,
  unwrapStateChange,
  collectStateChanges,
  stateMetric,
  eventCountMetric,
  toolCallCountMetric,
  eventSequenceMetric,
  timingMetric,
  durationMetric,
  isStateChangeResult,
  STATE_CHANGE_MARKER,
} from './index';
import {
  EvalToolError,
  EvalUserAgentError,
  EvalTerminatedError,
} from './errors';

describe('EvalRunner', () => {
  describe('tool interception', () => {
    it('should produce error result for unmocked tools', async () => {
      const unmockedTool = tool({
        name: 'unmocked_tool',
        description: 'A tool without a mock',
        schema: z.object({ input: z.string() }),
        execute: () => ({ result: 'real' }),
      });

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [unmockedTool],
      });

      const mockAdapter = new MockAdapter({
        responses: [
          {
            toolCalls: [{ name: 'unmocked_tool', args: { input: 'test' } }],
          },
          { text: 'Done' },
        ],
      });

      const runner = createEvalRunner({
        adapters: new Map([['openai', mockAdapter]]),
        toolMocks: {},
      });

      const session = await new EvalSessionService().createEvalSession('test');
      (session as any).addMessage('Hello');

      await runner.run(testAgent, session as any);

      const toolResult = session.events.find(
        (e): e is ToolResultEvent => e.type === 'tool_result',
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.error).toContain('unmocked_tool');
      expect(toolResult!.error).toContain('no mock was provided');
    });

    it('should use mock execute when provided', async () => {
      const mockedTool = tool({
        name: 'mocked_tool',
        description: 'A tool with a mock',
        schema: z.object({ input: z.string() }),
        execute: () => ({ result: 'real' }),
      });

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [mockedTool],
      });

      const mockAdapter = new MockAdapter({
        responses: [
          {
            toolCalls: [{ name: 'mocked_tool', args: { input: 'test' } }],
          },
          { text: 'Done' },
        ],
      });

      const runner = createEvalRunner({
        adapters: new Map([['openai', mockAdapter]]),
        toolMocks: {
          mocked_tool: { execute: () => ({ result: 'mocked' }) },
        },
      });

      const session = await new EvalSessionService().createEvalSession('test');
      (session as any).addMessage('Hello');

      await runner.run(testAgent, session as any);

      const toolResult = session.events.find(
        (e): e is ToolResultEvent => e.type === 'tool_result',
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.result).toEqual({ result: 'mocked' });
    });

    it('should allow real tool passthrough when tool is provided', async () => {
      const realTool = tool({
        name: 'real_tool',
        description: 'A real tool',
        schema: z.object({ input: z.string() }),
        execute: (ctx) => ({ echoed: ctx.args.input }),
      });

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [realTool],
      });

      const mockAdapter = new MockAdapter({
        responses: [
          {
            toolCalls: [{ name: 'real_tool', args: { input: 'passthrough' } }],
          },
          { text: 'Done' },
        ],
      });

      const runner = createEvalRunner({
        adapters: new Map([['openai', mockAdapter]]),
        toolMocks: {
          real_tool: realTool,
        },
      });

      const session = await new EvalSessionService().createEvalSession('test');
      (session as any).addMessage('Hello');

      await runner.run(testAgent, session as any);

      const toolResult = session.events.find(
        (e): e is ToolResultEvent => e.type === 'tool_result',
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.result).toEqual({ echoed: 'passthrough' });
    });
  });
});

describe('withStateChange', () => {
  it('should wrap result with state changes', () => {
    const result = withStateChange(
      { data: 'test' },
      { session: { key: 'value' } },
    );

    expect(isStateChangeResult(result)).toBe(true);
    expect(result.result).toEqual({ data: 'test' });
    expect(result.stateChanges).toEqual({ session: { key: 'value' } });
  });
});

describe('metrics', () => {
  describe('stateMetric', () => {
    it('should evaluate final state value', async () => {
      const events = [
        {
          type: 'state_change' as const,
          scope: 'session' as const,
          changes: [{ key: 'count', oldValue: undefined, newValue: 1 }],
        },
        {
          type: 'state_change' as const,
          scope: 'session' as const,
          changes: [{ key: 'count', oldValue: 1, newValue: 2 }],
        },
      ] as any[];

      const metric = stateMetric({
        name: 'count_check',
        scope: 'session',
        key: 'count',
        assertion: (v) => v === 2,
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(true);
      expect(result.value).toBe(2);
    });
  });

  describe('eventCountMetric', () => {
    it('should count matching events', async () => {
      const events = [
        { type: 'tool_call', name: 'ask' },
        { type: 'tool_call', name: 'ask' },
        { type: 'tool_call', name: 'other' },
      ] as any[];

      const metric = eventCountMetric({
        name: 'ask_count',
        eventType: 'tool_call',
        filter: (e: any) => e.name === 'ask',
        assertion: (count) => count <= 3,
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(true);
      expect(result.value).toBe(2);
    });
  });
});

describe('EvalSessionService', () => {
  it('should create session with initial state', async () => {
    const service = new EvalSessionService();
    const session = await service.createEvalSession('test', {
      session: { mode: 'triage' },
      patient: { age: 55 },
    });

    expect(session.state.session.get('mode')).toBe('triage');
    expect(session.state.patient.get('age')).toBe(55);
  });
});

describe('bridge helpers', () => {
  describe('unwrapStateChange', () => {
    it('should unwrap state change result', () => {
      const wrapped = withStateChange(
        { data: 'test' },
        { session: { key: 'value' } },
      );
      expect(unwrapStateChange(wrapped)).toEqual({ data: 'test' });
    });

    it('should return non-wrapped values unchanged', () => {
      const plain = { data: 'test' };
      expect(unwrapStateChange(plain)).toEqual({ data: 'test' });
    });
  });

  describe('collectStateChanges', () => {
    it('should collect state changes from multiple results', () => {
      const results = [
        withStateChange({ a: 1 }, { session: { key1: 'val1' } }),
        { plainResult: true },
        withStateChange({ b: 2 }, { patient: { condition: 'hypertension' } }),
        withStateChange(
          { c: 3 },
          { session: { key2: 'val2' }, user: { pref: 'dark' } },
        ),
      ];

      const collected = collectStateChanges(results);

      expect(collected.session).toEqual({ key1: 'val1', key2: 'val2' });
      expect(collected.patient).toEqual({ condition: 'hypertension' });
      expect(collected.user).toEqual({ pref: 'dark' });
    });

    it('should return empty object when no state changes', () => {
      const results = [{ plain: 1 }, { plain: 2 }];
      expect(collectStateChanges(results)).toEqual({});
    });
  });

  describe('isStateChangeResult', () => {
    it('should return false for plain objects', () => {
      expect(isStateChangeResult({ data: 'test' })).toBe(false);
      expect(isStateChangeResult(null)).toBe(false);
      expect(isStateChangeResult(undefined)).toBe(false);
      expect(isStateChangeResult('string')).toBe(false);
    });
  });
});

describe('error classes', () => {
  describe('EvalToolError', () => {
    it('should include tool name and args in message', () => {
      const error = new EvalToolError('searchPatients', { query: 'test' });
      expect(error.message).toContain('searchPatients');
      expect(error.message).toContain('no mock was provided');
      expect(error.toolName).toBe('searchPatients');
    });
  });

  describe('EvalUserAgentError', () => {
    it('should create error for missing loop agent', () => {
      const error = new EvalUserAgentError('loop');
      expect(error.message).toContain('Loop yielded');
      expect(error.yieldType).toBe('loop');
    });

    it('should create error for missing tool agent', () => {
      const error = new EvalUserAgentError('tool', 'ask', {
        question: 'How are you?',
      });
      expect(error.message).toContain("Tool 'ask' yielded");
      expect(error.toolName).toBe('ask');
    });
  });

  describe('EvalTerminatedError', () => {
    it('should create error for each termination reason', () => {
      expect(new EvalTerminatedError('maxTurns').reason).toBe('maxTurns');
      expect(new EvalTerminatedError('maxDuration').reason).toBe('maxDuration');
      expect(new EvalTerminatedError('stateMatches').reason).toBe(
        'stateMatches',
      );
    });
  });
});

describe('additional metrics', () => {
  describe('stateMetric', () => {
    it('should return passed: false when assertion fails', async () => {
      const events = [
        {
          type: 'state_change' as const,
          scope: 'session' as const,
          changes: [
            { key: 'status', oldValue: undefined, newValue: 'pending' },
          ],
        },
      ] as any[];

      const metric = stateMetric({
        name: 'completed_check',
        scope: 'session',
        key: 'status',
        assertion: (v) => v === 'completed',
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(false);
      expect(result.value).toBe('pending');
    });

    it('should handle undefined state values', async () => {
      const events: any[] = [];

      const metric = stateMetric({
        name: 'missing_key',
        scope: 'session',
        key: 'nonexistent',
        assertion: (v) => v === undefined,
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(true);
      expect(result.value).toBeUndefined();
    });
  });

  describe('toolCallCountMetric', () => {
    it('should count tool calls by name', async () => {
      const events = [
        { type: 'tool_call', name: 'ask' },
        { type: 'tool_call', name: 'ask' },
        { type: 'tool_call', name: 'escalate' },
        { type: 'tool_call', name: 'ask' },
      ] as any[];

      const metric = toolCallCountMetric({
        name: 'ask_count',
        toolName: 'ask',
        assertion: (count) => count === 3,
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(true);
      expect(result.value).toBe(3);
    });
  });

  describe('eventSequenceMetric', () => {
    it('should verify event sequence exists', async () => {
      const events = [
        { type: 'user', text: 'hello' },
        { type: 'tool_call', name: 'greet' },
        { type: 'tool_result', name: 'greet' },
        { type: 'assistant', text: 'hi' },
      ] as any[];

      const metric = eventSequenceMetric({
        name: 'greeting_flow',
        sequence: [
          { eventType: 'user' },
          { eventType: 'tool_call', filter: (e: any) => e.name === 'greet' },
          { eventType: 'assistant' },
        ],
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(true);
    });

    it('should fail when sequence is incomplete', async () => {
      const events = [
        { type: 'user', text: 'hello' },
        { type: 'assistant', text: 'hi' },
      ] as any[];

      const metric = eventSequenceMetric({
        name: 'missing_tool',
        sequence: [
          { eventType: 'user' },
          { eventType: 'tool_call' },
          { eventType: 'assistant' },
        ],
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(false);
    });
  });
});

describe('EvalRunner with nested runnables', () => {
  it('should intercept tools in sequence', async () => {
    const testTool = tool({
      name: 'seq_tool',
      description: 'Tool in sequence',
      schema: z.object({ x: z.number() }),
      execute: () => ({ original: true }),
    });

    const testAgent = agent({
      name: 'seq_agent',
      model: openai('gpt-4o-mini'),
      context: [injectSystemMessage('Test'), includeHistory()],
      tools: [testTool],
    });

    const testSequence = sequence({
      name: 'test_seq',
      runnables: [testAgent],
    });

    const mockAdapter = new MockAdapter({
      responses: [
        { toolCalls: [{ name: 'seq_tool', args: { x: 1 } }] },
        { text: 'Done' },
      ],
    });

    const runner = createEvalRunner({
      adapters: new Map([['openai', mockAdapter]]),
      toolMocks: {
        seq_tool: { execute: () => ({ mocked: true }) },
      },
    });

    const session = await new EvalSessionService().createEvalSession('test');
    (session as any).addMessage('Hello');

    await runner.run(testSequence, session as any);

    const toolResult = session.events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result',
    );
    expect(toolResult?.result).toEqual({ mocked: true });
  });
});

describe('EvalRunner strict mode', () => {
  it('should produce error result for unmocked tools in strict mode', async () => {
    const unmockedTool = tool({
      name: 'unmocked_strict',
      description: 'A tool without a mock',
      schema: z.object({ input: z.string() }),
      execute: () => ({ result: 'real' }),
    });

    const testAgent = agent({
      name: 'test_agent',
      model: openai('gpt-4o-mini'),
      context: [injectSystemMessage('Test'), includeHistory()],
      tools: [unmockedTool],
    });

    const mockAdapter = new MockAdapter({
      responses: [
        { toolCalls: [{ name: 'unmocked_strict', args: { input: 'test' } }] },
        { text: 'Done' },
      ],
    });

    const runner = createEvalRunner({
      adapters: new Map([['openai', mockAdapter]]),
      toolMocks: {},
      strict: true,
    });

    const session = await new EvalSessionService().createEvalSession('test');
    (session as any).addMessage('Hello');

    await runner.run(testAgent, session as any);

    const toolResult = session.events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result',
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.error).toContain('unmocked_strict');
    expect(toolResult!.error).toContain('no mock was provided');
  });

  it('should call onUnmockedTool callback when provided', async () => {
    const unmockedTool = tool({
      name: 'callback_tool',
      description: 'A tool without a mock',
      schema: z.object({ input: z.string() }),
      execute: () => ({ result: 'real' }),
    });

    const testAgent = agent({
      name: 'test_agent',
      model: openai('gpt-4o-mini'),
      context: [injectSystemMessage('Test'), includeHistory()],
      tools: [unmockedTool],
    });

    const mockAdapter = new MockAdapter({
      responses: [
        { toolCalls: [{ name: 'callback_tool', args: { input: 'test' } }] },
        { text: 'Done' },
      ],
    });

    const callbackArgs: Array<{ name: string; args: unknown }> = [];
    const runner = createEvalRunner({
      adapters: new Map([['openai', mockAdapter]]),
      toolMocks: {},
      onUnmockedTool: (name, args) => {
        callbackArgs.push({ name, args });
      },
    });

    const session = await new EvalSessionService().createEvalSession('test');
    (session as any).addMessage('Hello');

    await runner.run(testAgent, session as any);

    expect(callbackArgs).toHaveLength(1);
    expect(callbackArgs[0].name).toBe('callback_tool');
    expect(callbackArgs[0].args).toEqual({ input: 'test' });
  });

  it('should passthrough to original tool when onUnmockedTool is passthrough', async () => {
    const passthroughTool = tool({
      name: 'passthrough_tool',
      description: 'A tool that will passthrough',
      schema: z.object({ input: z.string() }),
      execute: (ctx) => ({ echoed: ctx.args.input, source: 'original' }),
    });

    const testAgent = agent({
      name: 'test_agent',
      model: openai('gpt-4o-mini'),
      context: [injectSystemMessage('Test'), includeHistory()],
      tools: [passthroughTool],
    });

    const mockAdapter = new MockAdapter({
      responses: [
        {
          toolCalls: [
            { name: 'passthrough_tool', args: { input: 'passthrough_test' } },
          ],
        },
        { text: 'Done' },
      ],
    });

    const runner = createEvalRunner({
      adapters: new Map([['openai', mockAdapter]]),
      toolMocks: {},
      onUnmockedTool: 'passthrough',
    });

    const session = await new EvalSessionService().createEvalSession('test');
    (session as any).addMessage('Hello');

    await runner.run(testAgent, session as any);

    const toolResult = session.events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result',
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.result).toEqual({
      echoed: 'passthrough_test',
      source: 'original',
    });
  });
});

describe('timing metrics', () => {
  describe('timingMetric', () => {
    it('should compute total duration from events', async () => {
      const now = Date.now();
      const events = [
        { type: 'invocation_start', timestamp: now },
        { type: 'user', text: 'hello', timestamp: now + 10 },
        { type: 'assistant', text: 'hi', timestamp: now + 100 },
        { type: 'invocation_end', timestamp: now + 200 },
      ] as any[];

      const metric = timingMetric({
        name: 'duration_test',
        measure: 'total_duration',
        assertion: (ms) => ms <= 300,
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(true);
      expect(result.value).toBe(200);
    });

    it('should compute model latency average', async () => {
      const events = [
        { type: 'model_start', timestamp: 0 },
        { type: 'model_end', timestamp: 100, durationMs: 100 },
        { type: 'model_start', timestamp: 200 },
        { type: 'model_end', timestamp: 350, durationMs: 150 },
      ] as any[];

      const metric = timingMetric({
        name: 'latency_test',
        measure: 'model_latency_average',
        assertion: (avg) => avg <= 150,
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(true);
      expect(result.value).toBe(125);
    });

    it('should return failed when no timestamp data', async () => {
      const events = [
        { type: 'user', text: 'hello' },
        { type: 'assistant', text: 'hi' },
      ] as any[];

      const metric = timingMetric({
        name: 'missing_data',
        measure: 'total_duration',
        assertion: () => true,
      });

      const result = await metric.evaluate(events);
      expect(result.passed).toBe(false);
      expect(result.evidence?.[0]).toContain('missing timestamp data');
    });
  });

  describe('durationMetric', () => {
    it('should check if total duration is within limit', async () => {
      const now = Date.now();
      const events = [
        { type: 'invocation_start', timestamp: now },
        { type: 'invocation_end', timestamp: now + 500 },
      ] as any[];

      const passingMetric = durationMetric({
        name: 'passing_duration',
        maxDurationMs: 1000,
      });

      const failingMetric = durationMetric({
        name: 'failing_duration',
        maxDurationMs: 100,
      });

      const passingResult = await passingMetric.evaluate(events);
      const failingResult = await failingMetric.evaluate(events);

      expect(passingResult.passed).toBe(true);
      expect(failingResult.passed).toBe(false);
    });
  });
});
