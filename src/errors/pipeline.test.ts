import { z } from 'zod';
import { BaseRunner } from '../core';
import { BaseSession, computePipelineFingerprint } from '../session';
import { PipelineStructureChangedError } from './pipeline';
import { agent, tool, loop } from '../index';
import { MockAdapter, createTestSession, testAgent } from '../testing';
import type { InvocationStartEvent, InvocationYieldEvent } from '../types';

describe('Pipeline validation on resume', () => {
  let mockAdapter: MockAdapter;
  let runner: BaseRunner;

  beforeEach(() => {
    mockAdapter = new MockAdapter();
    runner = new BaseRunner({
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    });
  });

  test('fingerprint is stored in root invocation_start event', async () => {
    mockAdapter.setResponses([{ text: 'Hello' }]);
    const myAgent = testAgent();
    const session = createTestSession('Hi');

    await runner.run(myAgent, session);

    const rootStart = session.events.find(
      (e): e is InvocationStartEvent =>
        e.type === 'invocation_start' && !e.parentInvocationId,
    );

    expect(rootStart).toBeDefined();
    expect(rootStart!.fingerprint).toBe(computePipelineFingerprint(myAgent));
  });

  test('version is stored when session has it', async () => {
    mockAdapter.setResponses([{ text: 'Hello' }]);
    const myAgent = testAgent();
    const session = new BaseSession('test_app', { version: '1.2.3' });
    session.addMessage('Hi');

    await runner.run(myAgent, session);

    const rootStart = session.events.find(
      (e): e is InvocationStartEvent =>
        e.type === 'invocation_start' && !e.parentInvocationId,
    );

    expect(rootStart).toBeDefined();
    expect(rootStart!.version).toBe('1.2.3');
  });

  test('child invocations do not have fingerprint', async () => {
    const yieldingTool = tool({
      name: 'yielding_tool',
      description: 'Yields',
      schema: z.object({}),
      yieldSchema: z.object({ done: z.boolean() }),
      execute: (ctx) => ({
        status: ctx.input ? 'complete' : 'pending',
        ...(ctx.input ?? {}),
      }),
    });

    mockAdapter.setResponses([
      { toolCalls: [{ name: 'yielding_tool', args: {} }] },
    ]);

    const myAgent = agent({
      name: 'test_agent',
      model: { provider: 'openai', name: 'gpt-4o-mini' },
      context: [],
      tools: [yieldingTool],
    });
    const session = createTestSession('Hi');

    await runner.run(myAgent, session);

    const allStarts = session.events.filter(
      (e): e is InvocationStartEvent => e.type === 'invocation_start',
    );

    const rootStart = allStarts.find((e) => !e.parentInvocationId);
    const childStarts = allStarts.filter((e) => e.parentInvocationId);

    expect(rootStart?.fingerprint).toBeDefined();
    for (const child of childStarts) {
      expect(child.fingerprint).toBeUndefined();
    }
  });

  test('throws PipelineStructureChangedError when fingerprint mismatches on resume', async () => {
    const yieldingTool = tool({
      name: 'yielding_tool',
      description: 'Yields',
      schema: z.object({}),
      yieldSchema: z.object({ done: z.boolean() }),
      execute: (ctx) => ({
        status: ctx.input ? 'complete' : 'pending',
        ...(ctx.input ?? {}),
      }),
    });

    const originalAgent = agent({
      name: 'test_agent',
      model: { provider: 'openai', name: 'gpt-4o-mini' },
      context: [],
      tools: [yieldingTool],
    });

    mockAdapter.setResponses([
      { toolCalls: [{ name: 'yielding_tool', args: {} }] },
    ]);
    const session = createTestSession('Hi');
    await runner.run(originalAgent, session);

    expect(session.status).toBe('awaiting_input');

    const modifiedAgent = agent({
      name: 'test_agent_modified',
      model: { provider: 'openai', name: 'gpt-4o-mini' },
      context: [],
      tools: [yieldingTool],
    });

    session.addToolInput(session.pendingYieldingCalls[0].callId, {
      done: true,
    });

    let caughtError: Error | null = null;
    try {
      await runner.run(modifiedAgent, session);
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).toBeInstanceOf(PipelineStructureChangedError);
    expect((caughtError as PipelineStructureChangedError).sessionId).toBe(
      session.id,
    );
  });

  test('resumes successfully when fingerprint matches', async () => {
    const yieldingTool = tool({
      name: 'yielding_tool',
      description: 'Yields',
      schema: z.object({}),
      yieldSchema: z.object({ done: z.boolean() }),
      execute: (ctx) => ({
        status: ctx.input ? 'complete' : 'pending',
        ...(ctx.input ?? {}),
      }),
    });

    const myAgent = agent({
      name: 'test_agent',
      model: { provider: 'openai', name: 'gpt-4o-mini' },
      context: [],
      tools: [yieldingTool],
    });

    mockAdapter.setResponses([
      { toolCalls: [{ name: 'yielding_tool', args: {} }] },
      { text: 'Done!' },
    ]);
    const session = createTestSession('Hi');

    await runner.run(myAgent, session);
    expect(session.status).toBe('awaiting_input');

    session.addToolInput(session.pendingYieldingCalls[0].callId, {
      done: true,
    });

    const result = await runner.run(myAgent, session);
    expect(result.status).toBe('completed');
  });

  test('no validation when session has no prior fingerprint (first run)', async () => {
    mockAdapter.setResponses([{ text: 'Hello' }]);
    const session = createTestSession('Hi');

    expect(session.events.length).toBe(1);

    const result = await runner.run(testAgent(), session);
    expect(result.status).toBe('completed');
  });
});

describe('PipelineStructureChangedError', () => {
  test('has expected properties', () => {
    const error = new PipelineStructureChangedError(
      'session-123',
      'abc123',
      'def456',
    );

    expect(error.name).toBe('PipelineStructureChangedError');
    expect(error.sessionId).toBe('session-123');
    expect(error.storedFingerprint).toBe('abc123');
    expect(error.currentFingerprint).toBe('def456');
    expect(error.message).toContain('session-123');
    expect(error.message).toContain('abc123');
    expect(error.message).toContain('def456');
  });

  test('accepts custom message', () => {
    const error = new PipelineStructureChangedError(
      'session-123',
      'abc123',
      'def456',
      'Custom error message',
    );

    expect(error.message).toBe('Custom error message');
  });
});
