import {
  CONTROL,
  isControlSignal,
  isYieldSignal,
  isRunnable,
  signalYield,
} from './index';
import { agent } from '../agents';
import { openai } from '../providers';
import { includeHistory } from '../context';
import { createEventId, createCallId } from '../session';
import type { ToolCallEvent } from '../types';

const createTestAgent = (name: string, description?: string) =>
  agent({
    name,
    description: description ?? name,
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
  });

describe('control signals', () => {
  test('isControlSignal identifies yield signals', () => {
    const yieldSignal = signalYield({
      invocationId: 'inv_123',
      pendingCalls: [],
    });

    expect(isControlSignal(yieldSignal)).toBe(true);
  });

  test('isControlSignal returns false for non-signals', () => {
    expect(isControlSignal({ foo: 'bar' })).toBe(false);
    expect(isControlSignal(null)).toBe(false);
    expect(isControlSignal('string')).toBe(false);
  });

  test('isYieldSignal correctly identifies yield signals', () => {
    const yieldSignal = signalYield({
      invocationId: 'inv_123',
      pendingCalls: [],
    });

    expect(isYieldSignal(yieldSignal)).toBe(true);
    expect(isYieldSignal({ foo: 'bar' })).toBe(false);
  });

  test('isRunnable correctly identifies runnables', () => {
    const targetAgent = createTestAgent('target');

    expect(isRunnable(targetAgent)).toBe(true);
    expect(isRunnable({ foo: 'bar' })).toBe(false);
    expect(isRunnable(null)).toBe(false);
    expect(isRunnable('string')).toBe(false);
  });

  test('signalYield creates signal with all fields', () => {
    const pendingCalls: ToolCallEvent[] = [
      {
        id: createEventId(),
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: 'inv_test',
        agentName: 'test_agent',
        callId: createCallId(),
        name: 'test_tool',
        args: {},
        yields: true,
      },
    ];

    const signal = signalYield({
      invocationId: 'inv_abc',
      pendingCalls,
      awaitingInput: true,
    });

    expect(signal[CONTROL]).toBe('yield');
    expect(signal.invocationId).toBe('inv_abc');
    expect(signal.pendingCalls).toBe(pendingCalls);
    expect(signal.awaitingInput).toBe(true);
  });
});
