import type {
  Event,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
  ToolCallEvent,
  ToolInputEvent,
  ToolResultEvent,
  Runnable,
  Agent,
  Sequence,
  Parallel,
  Loop,
} from '../../types';
import {
  computeResumeContext,
  validateResumeState,
  assertReadyToResume,
} from './context';
import type { SequenceResumeContext } from '../../agents/sequential';
import type { ParallelResumeContext } from '../../agents/parallel';
import type { LoopResumeContext } from '../../agents/loop';
import { openai } from '../../providers';
import { includeHistory } from '../../context';

const agent = (name: string): Agent => ({
  kind: 'agent',
  name,
  model: openai('gpt-4o-mini'),
  context: [includeHistory()],
  tools: [],
});

const seq = (name: string, runnables: Runnable[]): Sequence => ({
  kind: 'sequence',
  name,
  runnables,
});

const par = (name: string, runnables: Runnable[]): Parallel => ({
  kind: 'parallel',
  name,
  runnables,
});

const loop = (name: string, runnable: Runnable): Loop => ({
  kind: 'loop',
  name,
  runnable,
  maxIterations: 10,
  while: () => true,
});

const start = (
  id: string,
  name: string,
  parent?: string,
): InvocationStartEvent => ({
  id: `${id}-start`,
  type: 'invocation_start',
  createdAt: Date.now(),
  invocationId: id,
  agentName: name,
  parentInvocationId: parent,
  kind: 'agent',
});

const end = (
  id: string,
  name: string,
  reason: InvocationEndEvent['reason'],
  parent?: string,
): InvocationEndEvent => ({
  id: `${id}-end`,
  type: 'invocation_end',
  createdAt: Date.now(),
  invocationId: id,
  agentName: name,
  reason,
  parentInvocationId: parent,
});

const yld = (
  id: string,
  name: string,
  calls: string[],
  idx: number,
  parent?: string,
  awaitingInput?: boolean,
): InvocationYieldEvent => ({
  id: `${id}-yield`,
  type: 'invocation_yield',
  createdAt: Date.now(),
  invocationId: id,
  agentName: name,
  pendingCallIds: calls,
  yieldIndex: idx,
  parentInvocationId: parent,
  awaitingInput,
});

const resume = (
  id: string,
  name: string,
  idx: number,
): InvocationResumeEvent => ({
  id: `${id}-resume`,
  type: 'invocation_resume',
  createdAt: Date.now(),
  invocationId: id,
  agentName: name,
  yieldIndex: idx,
});

const call = (callId: string, inv: string): ToolCallEvent => ({
  id: `${callId}-call`,
  type: 'tool_call',
  createdAt: Date.now(),
  callId,
  name: 'tool',
  args: {},
  invocationId: inv,
  agentName: 'test_agent',
  yields: true,
});

const result = (callId: string, inv: string): ToolResultEvent => ({
  id: `${callId}-result`,
  type: 'tool_result',
  createdAt: Date.now(),
  callId,
  name: 'tool',
  result: {},
  invocationId: inv,
  agentName: 'test_agent',
});

const input = (callId: string, name: string = 'test_tool'): ToolInputEvent => ({
  id: `${callId}-input`,
  type: 'tool_input',
  createdAt: Date.now(),
  callId,
  name,
  input: {},
});

describe('computeResumeContext', () => {
  test('returns undefined for empty, completed, errored, or aborted', () => {
    expect(computeResumeContext([], agent('a'))).toBeUndefined();

    for (const reason of ['completed', 'error', 'aborted'] as const) {
      const events: Event[] = [start('i', 'a'), end('i', 'a', reason)];
      expect(computeResumeContext(events, agent('a'))).toBeUndefined();
    }
  });

  test('returns undefined when tool results missing', () => {
    const events: Event[] = [
      start('i', 'a'),
      call('c', 'i'),
      yld('i', 'a', ['c'], 0),
    ];
    expect(computeResumeContext(events, agent('a'))).toBeUndefined();
  });

  test('simple agent yield with resolved result', () => {
    const events: Event[] = [
      start('i', 'a'),
      call('c', 'i'),
      yld('i', 'a', ['c'], 0),
      input('c'),
    ];
    const ctx = computeResumeContext(events, agent('a'));
    expect(ctx).toMatchObject({ invocationId: 'i', yieldIndex: 0 });
  });

  test('sequence with yielded step', () => {
    const runnable = seq('s', [agent('a1'), agent('a2')]);
    const events: Event[] = [
      start('is', 's'),
      start('ia', 'a1', 'is'),
      call('c', 'ia'),
      yld('ia', 'a1', ['c'], 0, 'is'),
      yld('is', 's', ['c'], 0),
      input('c'),
    ];

    const ctx = computeResumeContext(events, runnable) as SequenceResumeContext;
    expect(ctx.invocationId).toBe('is');
    expect(ctx.stepIndex).toBe(0);
    expect(ctx.stepResumeContext?.invocationId).toBe('ia');
  });

  test('deeply nested sequences (4 levels)', () => {
    const leaf = agent('leaf');
    const l3 = seq('l3', [leaf]);
    const l2 = seq('l2', [l3]);
    const l1 = seq('l1', [l2]);
    const root = seq('root', [l1]);

    const events: Event[] = [
      start('r', 'root'),
      start('i1', 'l1', 'r'),
      start('i2', 'l2', 'i1'),
      start('i3', 'l3', 'i2'),
      start('il', 'leaf', 'i3'),
      call('c', 'il'),
      yld('il', 'leaf', ['c'], 0, 'i3'),
      yld('i3', 'l3', ['c'], 0, 'i2'),
      yld('i2', 'l2', ['c'], 0, 'i1'),
      yld('i1', 'l1', ['c'], 0, 'r'),
      yld('r', 'root', ['c'], 0),
      input('c'),
    ];

    let ctx = computeResumeContext(events, root) as SequenceResumeContext;
    const ids = ['r', 'i1', 'i2', 'i3'];
    for (const id of ids) {
      expect(ctx.invocationId).toBe(id);
      expect(ctx.stepIndex).toBe(0);
      if (ctx.stepResumeContext)
        ctx = ctx.stepResumeContext as SequenceResumeContext;
    }
  });

  test('parallel with yielded and completed branches', () => {
    const runnable = par('p', [agent('b1'), agent('b2')]);
    const events: Event[] = [
      start('ip', 'p'),
      start('i1', 'b1', 'ip'),
      start('i2', 'b2', 'ip'),
      call('c', 'i1'),
      yld('i1', 'b1', ['c'], 0, 'ip'),
      end('i2', 'b2', 'completed', 'ip'),
      yld('ip', 'p', ['c'], 0),
      input('c'),
    ];

    const ctx = computeResumeContext(events, runnable) as ParallelResumeContext;
    expect(ctx.invocationId).toBe('ip');
    expect(ctx.yieldedBranchIndices).toContain(0);
    expect(ctx.completedBranchIndices).toContain(1);
    expect(ctx.branchResumeContexts.get(0)?.invocationId).toBe('i1');
  });

  test('loop with yielded iteration', () => {
    const runnable = loop('lp', agent('iter'));
    const events: Event[] = [
      start('il', 'lp'),
      start('ii', 'iter', 'il'),
      call('c', 'ii'),
      yld('ii', 'iter', ['c'], 0, 'il'),
      yld('il', 'lp', ['c'], 0),
      input('c'),
    ];

    const ctx = computeResumeContext(events, runnable) as LoopResumeContext;
    expect(ctx.invocationId).toBe('il');
    expect(ctx.iteration).toBe(0);
    expect(ctx.iterationResumeContext?.invocationId).toBe('ii');
  });

  test('loop awaiting input (no pending tool calls)', () => {
    const runnable = loop('lp', agent('chat'));
    const events: Event[] = [
      start('il', 'lp'),
      start('ii', 'chat', 'il'),
      end('ii', 'chat', 'completed', 'il'),
      yld('il', 'lp', [], 0, undefined, true),
    ];

    const ctx = computeResumeContext(events, runnable) as LoopResumeContext;
    expect(ctx.iteration).toBe(1);
    expect(ctx.iterationResumeContext).toBeUndefined();
  });

  test('nested loops (2 levels)', () => {
    const inner = loop('inner', agent('a'));
    const outer = loop('outer', inner);
    const events: Event[] = [
      start('io', 'outer'),
      start('ii', 'inner', 'io'),
      start('ia', 'a', 'ii'),
      call('c', 'ia'),
      yld('ia', 'a', ['c'], 0, 'ii'),
      yld('ii', 'inner', ['c'], 0, 'io'),
      yld('io', 'outer', ['c'], 0),
      input('c'),
    ];

    const ctx = computeResumeContext(events, outer) as LoopResumeContext;
    expect(ctx.invocationId).toBe('io');
    const innerCtx = ctx.iterationResumeContext as LoopResumeContext;
    expect(innerCtx.invocationId).toBe('ii');
    expect(innerCtx.iterationResumeContext?.invocationId).toBe('ia');
  });

  test('mixed: sequence > parallel > loop > agent', () => {
    const a = agent('a');
    const lp = loop('lp', a);
    const p = par('p', [lp, agent('b')]);
    const s = seq('s', [p]);

    const events: Event[] = [
      start('is', 's'),
      start('ip', 'p', 'is'),
      start('il', 'lp', 'ip'),
      start('ib', 'b', 'ip'),
      start('ia', 'a', 'il'),
      call('c', 'ia'),
      yld('ia', 'a', ['c'], 0, 'il'),
      yld('il', 'lp', ['c'], 0, 'ip'),
      end('ib', 'b', 'completed', 'ip'),
      yld('ip', 'p', ['c'], 0, 'is'),
      yld('is', 's', ['c'], 0),
      input('c'),
    ];

    const ctx = computeResumeContext(events, s) as SequenceResumeContext;
    expect(ctx.invocationId).toBe('is');
    expect(ctx.stepIndex).toBe(0);
    const parCtx = ctx.stepResumeContext as ParallelResumeContext;
    expect(parCtx.yieldedBranchIndices).toContain(0);
    expect(parCtx.completedBranchIndices).toContain(1);
  });

  test('multiple yields (second yield after resume)', () => {
    const a = agent('a');
    const events: Event[] = [
      start('i', 'a'),
      call('c1', 'i'),
      yld('i', 'a', ['c1'], 0),
      input('c1'),
      resume('i', 'a', 0),
      call('c2', 'i'),
      yld('i', 'a', ['c2'], 1),
      input('c2'),
    ];

    const ctx = computeResumeContext(events, a);
    expect(ctx).toMatchObject({ invocationId: 'i', yieldIndex: 1 });
  });
});

describe('validateResumeState', () => {
  test('returns empty when all resolved', () => {
    const events: Event[] = [
      start('i', 'a'),
      call('c', 'i'),
      yld('i', 'a', ['c'], 0),
      input('c'),
    ];
    expect(validateResumeState(events)).toEqual([]);
  });

  test('returns unresolved yields', () => {
    const events: Event[] = [
      start('i', 'a'),
      call('c', 'i'),
      yld('i', 'a', ['c'], 0),
    ];
    expect(validateResumeState(events)).toEqual([
      { agentName: 'a', callId: 'c' },
    ]);
  });
});

describe('assertReadyToResume', () => {
  test('does not throw when resolved', () => {
    const events: Event[] = [
      start('i', 'a'),
      call('c', 'i'),
      yld('i', 'a', ['c'], 0),
      input('c'),
    ];
    expect(() => assertReadyToResume(events)).not.toThrow();
  });

  test('throws with unresolved call IDs', () => {
    const events: Event[] = [
      start('i', 'a'),
      call('c', 'i'),
      yld('i', 'a', ['c'], 0),
    ];
    expect(() => assertReadyToResume(events)).toThrow(/Cannot resume.*c/);
  });
});
