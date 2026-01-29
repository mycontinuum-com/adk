import type { Event } from '../types';
import { BaseSession } from './base';
import {
  computeStateAtEvent,
  computeAllStatesAtEvent,
  snapshotAt,
  findEventIndex,
  findInvocationBoundary,
  SnapshotError,
} from './snapshot';

function createStateChangeEvent(
  id: string,
  scope: 'session' | 'user' | 'patient' | 'practice',
  key: string,
  oldValue: unknown,
  newValue: unknown,
  invocationId?: string,
): Event {
  return {
    id,
    type: 'state_change',
    createdAt: Date.now(),
    scope,
    source: 'mutation',
    invocationId,
    changes: [{ key, oldValue, newValue }],
  };
}

function createUserEvent(id: string, text: string): Event {
  return {
    id,
    type: 'user',
    createdAt: Date.now(),
    text,
  };
}

function createInvocationStartEvent(
  id: string,
  invocationId: string,
  agentName: string,
  parentInvocationId?: string,
): Event {
  return {
    id,
    type: 'invocation_start',
    createdAt: Date.now(),
    invocationId,
    agentName,
    kind: 'agent',
    parentInvocationId,
  };
}

function createInvocationEndEvent(
  id: string,
  invocationId: string,
  agentName: string,
  reason: 'completed' | 'error' = 'completed',
): Event {
  return {
    id,
    type: 'invocation_end',
    createdAt: Date.now(),
    invocationId,
    agentName,
    reason,
  };
}

function createToolCallEvent(
  id: string,
  callId: string,
  name: string,
  invocationId: string,
  agentName: string,
  yields?: boolean,
): Event {
  return {
    id,
    type: 'tool_call',
    createdAt: Date.now(),
    callId,
    name,
    args: {},
    invocationId,
    agentName,
    yields,
  };
}

function createToolResultEvent(
  id: string,
  callId: string,
  name: string,
  invocationId: string,
  agentName: string,
): Event {
  return {
    id,
    type: 'tool_result',
    createdAt: Date.now(),
    callId,
    name,
    result: {},
    invocationId,
    agentName,
  };
}

describe('computeStateAtEvent', () => {
  test('computes state at specific event index', () => {
    const events: Event[] = [
      createStateChangeEvent('1', 'session', 'count', undefined, 1),
      createStateChangeEvent('2', 'session', 'count', 1, 2),
      createStateChangeEvent('3', 'session', 'count', 2, 3),
    ];

    expect(computeStateAtEvent(events, 0)).toEqual({ count: 1 });
    expect(computeStateAtEvent(events, 1)).toEqual({ count: 2 });
    expect(computeStateAtEvent(events, 2)).toEqual({ count: 3 });
  });

  test('handles multiple keys', () => {
    const events: Event[] = [
      createStateChangeEvent('1', 'session', 'a', undefined, 1),
      createStateChangeEvent('2', 'session', 'b', undefined, 2),
      createStateChangeEvent('3', 'session', 'a', 1, 10),
    ];

    expect(computeStateAtEvent(events, 0)).toEqual({ a: 1 });
    expect(computeStateAtEvent(events, 1)).toEqual({ a: 1, b: 2 });
    expect(computeStateAtEvent(events, 2)).toEqual({ a: 10, b: 2 });
  });

  test('handles deletions', () => {
    const events: Event[] = [
      createStateChangeEvent('1', 'session', 'key', undefined, 'value'),
      createStateChangeEvent('2', 'session', 'key', 'value', undefined),
    ];

    expect(computeStateAtEvent(events, 0)).toEqual({ key: 'value' });
    expect(computeStateAtEvent(events, 1)).toEqual({});
  });

  test('filters by scope', () => {
    const events: Event[] = [
      createStateChangeEvent(
        '1',
        'session',
        'sessionKey',
        undefined,
        'session',
      ),
      createStateChangeEvent('2', 'user', 'userKey', undefined, 'user'),
      createStateChangeEvent(
        '3',
        'patient',
        'patientKey',
        undefined,
        'patient',
      ),
    ];

    expect(computeStateAtEvent(events, 2, 'session')).toEqual({
      sessionKey: 'session',
    });
    expect(computeStateAtEvent(events, 2, 'user')).toEqual({ userKey: 'user' });
    expect(computeStateAtEvent(events, 2, 'patient')).toEqual({
      patientKey: 'patient',
    });
  });

  test('throws on out of bounds index', () => {
    const events: Event[] = [
      createStateChangeEvent('1', 'session', 'key', undefined, 'value'),
    ];

    expect(() => computeStateAtEvent(events, -1)).toThrow(SnapshotError);
    expect(() => computeStateAtEvent(events, 1)).toThrow(SnapshotError);
    expect(() => computeStateAtEvent(events, 100)).toThrow(SnapshotError);
  });

  test('includes non-state events in index calculation', () => {
    const events: Event[] = [
      createUserEvent('1', 'Hello'),
      createStateChangeEvent('2', 'session', 'key', undefined, 'first'),
      createUserEvent('3', 'World'),
      createStateChangeEvent('4', 'session', 'key', 'first', 'second'),
    ];

    expect(computeStateAtEvent(events, 0)).toEqual({});
    expect(computeStateAtEvent(events, 1)).toEqual({ key: 'first' });
    expect(computeStateAtEvent(events, 2)).toEqual({ key: 'first' });
    expect(computeStateAtEvent(events, 3)).toEqual({ key: 'second' });
  });
});

describe('computeAllStatesAtEvent', () => {
  test('computes all scopes in single pass', () => {
    const events: Event[] = [
      createStateChangeEvent('1', 'session', 'sessionKey', undefined, 's1'),
      createStateChangeEvent('2', 'user', 'userKey', undefined, 'u1'),
      createStateChangeEvent('3', 'patient', 'patientKey', undefined, 'p1'),
      createStateChangeEvent('4', 'practice', 'practiceKey', undefined, 'pr1'),
    ];

    const result = computeAllStatesAtEvent(events, 3);
    expect(result.session).toEqual({ sessionKey: 's1' });
    expect(result.user).toEqual({ userKey: 'u1' });
    expect(result.patient).toEqual({ patientKey: 'p1' });
    expect(result.practice).toEqual({ practiceKey: 'pr1' });
  });
});

describe('snapshotAt', () => {
  test('creates full snapshot at event index', () => {
    const events: Event[] = [
      createInvocationStartEvent('1', 'inv-1', 'test_agent'),
      createStateChangeEvent(
        '2',
        'session',
        'key',
        undefined,
        'value',
        'inv-1',
      ),
      createInvocationEndEvent('3', 'inv-1', 'test_agent', 'completed'),
    ];

    const snapshot = snapshotAt(events, 2);

    expect(snapshot.eventIndex).toBe(2);
    expect(snapshot.eventId).toBe('3');
    expect(snapshot.sessionState).toEqual({ key: 'value' });
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentAgentName).toBeUndefined();
    expect(snapshot.event).toBe(events[2]);
  });

  test('captures current agent during invocation', () => {
    const events: Event[] = [
      createInvocationStartEvent('1', 'inv-1', 'agent_a'),
      createStateChangeEvent(
        '2',
        'session',
        'key',
        undefined,
        'value',
        'inv-1',
      ),
    ];

    const snapshot = snapshotAt(events, 1);
    expect(snapshot.currentAgentName).toBe('agent_a');
    expect(snapshot.status).toBe('active');
  });

  test('tracks pending yielding calls', () => {
    const events: Event[] = [
      createInvocationStartEvent('1', 'inv-1', 'agent_a'),
      createToolCallEvent('2', 'call-1', 'approval', 'inv-1', 'agent_a', true),
    ];

    const snapshot = snapshotAt(events, 1);
    expect(snapshot.pendingYieldingCalls).toHaveLength(1);
    expect(snapshot.pendingYieldingCalls[0].callId).toBe('call-1');
    expect(snapshot.status).toBe('awaiting_input');
  });

  test('resolved yielding calls are not pending', () => {
    const events: Event[] = [
      createInvocationStartEvent('1', 'inv-1', 'agent_a'),
      createToolCallEvent('2', 'call-1', 'approval', 'inv-1', 'agent_a', true),
      createToolResultEvent('3', 'call-1', 'approval', 'inv-1', 'agent_a'),
    ];

    const snapshot = snapshotAt(events, 2);
    expect(snapshot.pendingYieldingCalls).toHaveLength(0);
    expect(snapshot.status).toBe('active');
  });

  test('builds invocation tree', () => {
    const events: Event[] = [
      createInvocationStartEvent('1', 'inv-1', 'parent_agent'),
      createInvocationStartEvent('2', 'inv-2', 'child_agent', 'inv-1'),
      createInvocationEndEvent('3', 'inv-2', 'child_agent'),
    ];

    const snapshot = snapshotAt(events, 2);
    expect(snapshot.invocationTree).toHaveLength(1);
    expect(snapshot.invocationTree[0].agentName).toBe('parent_agent');
    expect(snapshot.invocationTree[0].children).toHaveLength(1);
    expect(snapshot.invocationTree[0].children[0].agentName).toBe(
      'child_agent',
    );
  });

  test('throws on empty events', () => {
    expect(() => snapshotAt([], 0)).toThrow(SnapshotError);
  });

  test('throws on out of bounds', () => {
    const events: Event[] = [createUserEvent('1', 'Hello')];
    expect(() => snapshotAt(events, -1)).toThrow(SnapshotError);
    expect(() => snapshotAt(events, 1)).toThrow(SnapshotError);
  });

  test('includes all state scopes', () => {
    const events: Event[] = [
      createStateChangeEvent('1', 'session', 'a', undefined, 1),
      createStateChangeEvent('2', 'user', 'b', undefined, 2),
      createStateChangeEvent('3', 'patient', 'c', undefined, 3),
      createStateChangeEvent('4', 'practice', 'd', undefined, 4),
    ];

    const snapshot = snapshotAt(events, 3);
    expect(snapshot.sessionState).toEqual({ a: 1 });
    expect(snapshot.userState).toEqual({ b: 2 });
    expect(snapshot.patientState).toEqual({ c: 3 });
    expect(snapshot.practiceState).toEqual({ d: 4 });
  });
});

describe('findEventIndex', () => {
  test('finds event by id', () => {
    const events: Event[] = [
      createUserEvent('event-1', 'First'),
      createUserEvent('event-2', 'Second'),
      createUserEvent('event-3', 'Third'),
    ];

    expect(findEventIndex(events, 'event-1')).toBe(0);
    expect(findEventIndex(events, 'event-2')).toBe(1);
    expect(findEventIndex(events, 'event-3')).toBe(2);
  });

  test('returns undefined for missing id', () => {
    const events: Event[] = [createUserEvent('event-1', 'First')];
    expect(findEventIndex(events, 'nonexistent')).toBeUndefined();
  });
});

describe('findInvocationBoundary', () => {
  test('finds start and end of invocation', () => {
    const events: Event[] = [
      createInvocationStartEvent('1', 'inv-1', 'test_agent'),
      createUserEvent('2', 'Hello'),
      createInvocationEndEvent('3', 'inv-1', 'test_agent'),
    ];

    const boundary = findInvocationBoundary(events, 'inv-1');
    expect(boundary).toEqual({
      invocationId: 'inv-1',
      agentName: 'test_agent',
      startIndex: 0,
      endIndex: 2,
    });
  });

  test('returns undefined end for incomplete invocation', () => {
    const events: Event[] = [
      createInvocationStartEvent('1', 'inv-1', 'test_agent'),
      createUserEvent('2', 'Hello'),
    ];

    const boundary = findInvocationBoundary(events, 'inv-1');
    expect(boundary).toEqual({
      invocationId: 'inv-1',
      agentName: 'test_agent',
      startIndex: 0,
      endIndex: undefined,
    });
  });

  test('returns undefined for missing invocation', () => {
    const events: Event[] = [createUserEvent('1', 'Hello')];
    expect(findInvocationBoundary(events, 'nonexistent')).toBeUndefined();
  });
});

describe('BaseSession time-travel methods', () => {
  describe('stateAt', () => {
    test('returns snapshot at event index', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('inv-1');
      session.pushEvent(createInvocationStartEvent('1', 'inv-1', 'agent'));
      state.session.set('key', 'first');
      state.session.set('key', 'second');

      const snapshot = session.stateAt(1);
      expect(snapshot.sessionState).toEqual({ key: 'first' });

      const snapshot2 = session.stateAt(2);
      expect(snapshot2.sessionState).toEqual({ key: 'second' });
    });
  });

  describe('eventIndexOf', () => {
    test('returns index of event', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.pushEvent(createUserEvent('a', 'First'));
      session.pushEvent(createUserEvent('b', 'Second'));

      expect(session.eventIndexOf('a')).toBe(0);
      expect(session.eventIndexOf('b')).toBe(1);
      expect(session.eventIndexOf('c')).toBeUndefined();
    });
  });

  describe('invocationBoundary', () => {
    test('returns boundary of invocation', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.pushEvent(createInvocationStartEvent('1', 'inv-1', 'agent'));
      session.pushEvent(createUserEvent('2', 'Hello'));
      session.pushEvent(createInvocationEndEvent('3', 'inv-1', 'agent'));

      const boundary = session.invocationBoundary('inv-1');
      expect(boundary).toEqual({
        invocationId: 'inv-1',
        agentName: 'agent',
        startIndex: 0,
        endIndex: 2,
      });
    });
  });

  describe('forkAt', () => {
    test('creates isolated session copy at event index', () => {
      const session = new BaseSession('app', {
        id: 'original',
        userId: 'user-1',
        patientId: 'patient-1',
      });
      const state = session.createBoundState('inv-1');
      session.pushEvent(createInvocationStartEvent('1', 'inv-1', 'agent'));
      state.session.set('step', 1);
      state.session.set('step', 2);
      state.session.set('step', 3);

      const forked = session.forkAt(2);

      expect(forked.id).not.toBe(session.id);
      expect(forked.userId).toBe('user-1');
      expect(forked.patientId).toBe('patient-1');
      expect(forked.events).toHaveLength(3);
      expect(forked.createBoundState('inv-1').session.get('step')).toBe(2);
      expect(state.session.get('step')).toBe(3);
    });

    test('forked session has isolated shared state', () => {
      const session = new BaseSession('app', { id: 'original' });
      const userState = { preference: 'dark' };
      session.bindSharedState('user', userState);
      const state = session.createBoundState('inv-1');
      session.pushEvent(createInvocationStartEvent('1', 'inv-1', 'agent'));
      state.user.set('preference', 'light');

      const forked = session.forkAt(1);

      const forkedState = forked.createBoundState('inv-2');
      forkedState.user.set('preference', 'system');

      expect(state.user.get('preference')).toBe('light');
      expect(forkedState.user.get('preference')).toBe('system');
      expect(userState.preference).toBe('light');
    });

    test('forked session can continue execution independently', () => {
      const session = new BaseSession('app', { id: 'original' });
      const state = session.createBoundState('inv-1');
      session.pushEvent(createInvocationStartEvent('1', 'inv-1', 'agent'));
      session.addMessage('First question');
      state.session.set('answered', 1);

      const forked = session.forkAt(1);

      session.addMessage('Continue original');
      forked.addMessage('Different path');

      expect(session.events).toHaveLength(4);
      expect(forked.events).toHaveLength(3);
    });

    test('throws on out of bounds index', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.pushEvent(createUserEvent('1', 'Hello'));

      expect(() => session.forkAt(-1)).toThrow(SnapshotError);
      expect(() => session.forkAt(1)).toThrow(SnapshotError);
    });

    test('preserves events up to and including the target index', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.pushEvent(createUserEvent('1', 'First'));
      session.pushEvent(createUserEvent('2', 'Second'));
      session.pushEvent(createUserEvent('3', 'Third'));

      const forked = session.forkAt(1);

      expect(forked.events).toHaveLength(2);
      expect(forked.events[0].id).toBe('1');
      expect(forked.events[1].id).toBe('2');
    });
  });
});
