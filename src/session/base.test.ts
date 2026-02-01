import { BaseSession } from './base';
import { createTestSession, setupAdkMatchers } from '../testing';

setupAdkMatchers();

describe('BaseSession', () => {
  describe('construction', () => {
    test('creates session with auto-generated ID', () => {
      const session = new BaseSession('app');
      expect(session.id).toBeUuid();
      expect(session.appName).toBe('app');
      expect(session.events).toEqual([]);
      expect(session.createdAt).toBeGreaterThan(0);
    });

    test('creates session with provided ID', () => {
      const session = new BaseSession('app', { id: 'custom-id' });
      expect(session.id).toBe('custom-id');
    });

    test('creates session with user, patient, and practice IDs', () => {
      const session = new BaseSession('app', {
        id: 's1',
        userId: 'user1',
        patientId: 'patient1',
        practiceId: 'practice1',
      });
      expect(session.userId).toBe('user1');
      expect(session.patientId).toBe('patient1');
      expect(session.practiceId).toBe('practice1');
    });
  });

  describe('addMessage', () => {
    test('adds user message to events', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.addMessage('Hello');

      expect(session.events).toHaveLength(1);
      expect(session.events[0]).toMatchObject({
        type: 'user',
        text: 'Hello',
      });
      expect(session.events[0].id).toBeUuid();
      expect(session.events[0].createdAt).toBeGreaterThan(0);
    });

    test('returns this for chaining', () => {
      const session = new BaseSession('app', { id: 'test' });
      const result = session.addMessage('Hello');
      expect(result).toBe(session);
    });

    test('can chain multiple messages', () => {
      const session = new BaseSession('app', { id: 'test' })
        .addMessage('First')
        .addMessage('Second');

      expect(session.events).toHaveLength(2);
      expect(session.events[0]).toMatchObject({ type: 'user', text: 'First' });
      expect(session.events[1]).toMatchObject({ type: 'user', text: 'Second' });
    });
  });

  describe('append', () => {
    test('appends events to session', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.append([
        {
          id: '1',
          type: 'system',
          createdAt: Date.now(),
          invocationId: 'test-inv',
          agentName: 'test_agent',
          text: 'System message',
        },
        { id: '2', type: 'user', createdAt: Date.now(), text: 'User message' },
      ]);

      expect(session.events).toHaveLength(2);
    });
  });

  describe('clone', () => {
    test('creates deep copy of session', () => {
      const original = new BaseSession('app', {
        id: 'test',
        userId: 'user1',
        patientId: 'patient1',
        practiceId: 'practice1',
      });
      original.addMessage('Hello');
      original.state.key = 'value';

      const cloned = original.clone();

      expect(cloned.id).toBe(original.id);
      expect(cloned.userId).toBe(original.userId);
      expect(cloned.events).toHaveLength(original.events.length);
      expect(cloned.events).not.toBe(original.events);
      expect(cloned.state.key).toBe('value');
    });

    test('cloned session events are independent', () => {
      const original = new BaseSession('app', { id: 'test' });
      original.addMessage('Original');

      const cloned = original.clone();
      cloned.addMessage('Cloned');

      expect(original.events).toHaveLength(1);
      expect(cloned.events).toHaveLength(2);
    });
  });

  describe('session state', () => {
    test('set and get state values via property access', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.state.key = 'value';
      expect(session.state.key).toBe('value');
    });

    test('get returns undefined for missing keys', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(session.state.missing).toBeUndefined();
    });

    test('Object.assign sets multiple values', () => {
      const session = new BaseSession('app', { id: 'test' });
      Object.assign(session.state, { a: 1, b: 2, c: 3 });

      expect(session.state.a).toBe(1);
      expect(session.state.b).toBe(2);
      expect(session.state.c).toBe(3);
    });

    test('setting undefined removes values', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.state.key = 'value';
      session.state.key = undefined;

      expect(session.state.key).toBeUndefined();
    });

    test('spread returns state snapshot', () => {
      const session = new BaseSession('app', { id: 'test' });
      Object.assign(session.state, { a: 1, b: 'two' });

      expect({ ...session.state }).toEqual({ a: 1, b: 'two' });
    });

    test('direct state changes use direct source', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.state.key = 'value';

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'session',
        source: 'direct',
        changes: [{ key: 'key', oldValue: undefined, newValue: 'value' }],
      });
    });

    test('bound state changes use mutation source', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.boundState('test-inv');
      state.key = 'value';

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'session',
        source: 'mutation',
        invocationId: 'test-inv',
        changes: [{ key: 'key', oldValue: undefined, newValue: 'value' }],
      });
    });

    test('no event when setting same value', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.state.key = 'value';
      session.state.key = 'value';

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(1);
    });

    test('state is computed from events (event-sourced)', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.state.a = 1;
      session.state.b = 2;
      session.state.a = 10;
      session.state.b = undefined;

      expect({ ...session.state }).toEqual({ a: 10 });
    });
  });

  describe('temp state', () => {
    test('temp state is scoped to invocation via boundState', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state1 = session.boundState('inv-1');
      state1.temp.key = 'value';
      expect(state1.temp.key).toBe('value');

      const state2 = session.boundState('inv-2');
      expect(state2.temp.key).toBeUndefined();

      expect(state1.temp.key).toBe('value');
    });

    test('temp state is not logged as events', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.boundState('inv-1');
      state.temp.key = 'value';

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(0);
    });

    test('clearTempState clears specific invocation scope', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.boundState('inv-1');
      state.temp.key = 'value';
      expect(state.temp.key).toBe('value');

      session.clearTempState('inv-1');
      expect(state.temp.key).toBeUndefined();
    });

    test('clearTempState without invocationId clears all scopes', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state1 = session.boundState('inv-1');
      state1.temp.key1 = 'value1';
      const state2 = session.boundState('inv-2');
      state2.temp.key2 = 'value2';

      session.clearTempState();

      expect(state1.temp.key1).toBeUndefined();
      expect(state2.temp.key2).toBeUndefined();
    });

    test('inheritTempState copies parent state to child', () => {
      const session = new BaseSession('app', { id: 'test' });
      const parentState = session.boundState('parent');
      parentState.temp.shared = 'data';
      parentState.temp.config = 'value';

      session.inheritTempState('parent', 'child');

      const childState = session.boundState('child');
      expect(childState.temp.shared).toBe('data');
      expect(childState.temp.config).toBe('value');
    });

    test('inheritTempState merges overrides on top of parent state', () => {
      const session = new BaseSession('app', { id: 'test' });
      const parentState = session.boundState('parent');
      parentState.temp.shared = 'data';
      parentState.temp.config = 'original';

      session.inheritTempState('parent', 'child', {
        config: 'overridden',
        extra: 'new',
      });

      const childState = session.boundState('child');
      expect(childState.temp.shared).toBe('data');
      expect(childState.temp.config).toBe('overridden');
      expect(childState.temp.extra).toBe('new');
    });

    test('child modifications do not affect parent', () => {
      const session = new BaseSession('app', { id: 'test' });
      const parentState = session.boundState('parent');
      parentState.temp.shared = 'original';

      session.inheritTempState('parent', 'child');

      const childState = session.boundState('child');
      childState.temp.shared = 'modified';

      expect(parentState.temp.shared).toBe('original');
    });

    test('session.state.temp throws without invocation context', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(() => ({ ...session.state.temp })).toThrow(
        'Temp state requires an invocation context',
      );
    });

    test('session.state.temp throws on property access', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(() => session.state.temp.key).toThrow();
      expect(() => { session.state.temp.key = 'value'; }).toThrow();
    });
  });

  describe('shared state scopes (user, patient, practice)', () => {
    test('unbound shared state returns empty', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect({ ...session.state.user }).toEqual({});
      expect({ ...session.state.patient }).toEqual({});
      expect({ ...session.state.practice }).toEqual({});
    });

    test('bindSharedState connects external state', () => {
      const session = new BaseSession('app', { id: 'test' });
      const userState = { preference: 'dark' };

      session.bindSharedState('user', userState);

      expect(session.state.user.preference).toBe('dark');
    });

    test('direct shared state modifications update external reference', () => {
      const session = new BaseSession('app', { id: 'test' });
      const userState: Record<string, unknown> = {};

      session.bindSharedState('user', userState);
      session.state.user.preference = 'light';

      expect(userState.preference).toBe('light');
    });

    test('direct shared state changes use direct source', () => {
      const session = new BaseSession('app', { id: 'test' });
      const patientState: Record<string, unknown> = {};

      session.bindSharedState('patient', patientState);
      session.state.patient.diagnosis = 'diabetes';

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'patient',
        source: 'direct',
        changes: [
          { key: 'diagnosis', oldValue: undefined, newValue: 'diabetes' },
        ],
      });
    });

    test('bound shared state changes use mutation source', () => {
      const session = new BaseSession('app', { id: 'test' });
      const patientState: Record<string, unknown> = {};

      session.bindSharedState('patient', patientState);
      session.boundState('test-inv').patient.diagnosis = 'diabetes';

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'patient',
        source: 'mutation',
        invocationId: 'test-inv',
        changes: [
          { key: 'diagnosis', oldValue: undefined, newValue: 'diabetes' },
        ],
      });
    });

    test('onChange callback is invoked on state change', () => {
      const session = new BaseSession('app', { id: 'test' });
      const userState: Record<string, unknown> = {};
      const onChange = jest.fn();

      session.bindSharedState('user', userState, onChange);
      session.state.user.theme = 'dark';

      expect(onChange).toHaveBeenCalledWith('theme', 'dark');
    });
  });

  describe('onStateChange callback', () => {
    test('callback receives state change events', () => {
      const session = new BaseSession('app', { id: 'test' });
      const callback = jest.fn();

      session.onStateChange(callback);
      session.state.key = 'value';

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state_change',
          scope: 'session',
          source: 'direct',
          changes: [{ key: 'key', oldValue: undefined, newValue: 'value' }],
        }),
      );
    });
  });

  describe('toJSON', () => {
    test('serializes session to JSON-compatible object', () => {
      const session = new BaseSession('app', {
        id: 'test',
        userId: 'user1',
        patientId: 'patient1',
        practiceId: 'practice1',
      });
      session.addMessage('Hello');
      session.state.key = 'value';

      const json = session.toJSON();

      expect(json.id).toBe('test');
      expect(json.userId).toBe('user1');
      expect(json.patientId).toBe('patient1');
      expect(json.practiceId).toBe('practice1');
      expect(json.events).toHaveLength(2);
      expect(json.state).toEqual({ key: 'value' });
    });
  });

  describe('fromSnapshot', () => {
    test('restores session from snapshot', () => {
      const snapshot = {
        appName: 'app',
        id: 'restored',
        userId: 'user1',
        patientId: 'patient1',
        practiceId: 'practice1',
        events: [
          {
            id: '1',
            type: 'user' as const,
            createdAt: Date.now(),
            text: 'Hello',
          },
          {
            id: '2',
            type: 'state_change' as const,
            scope: 'session' as const,
            source: 'mutation' as const,
            createdAt: Date.now(),
            invocationId: 'inv-test',
            changes: [{ key: 'restored', oldValue: undefined, newValue: true }],
          },
        ],
        userState: { pref: 'dark' },
        patientState: { condition: 'stable' },
      };

      const session = BaseSession.fromSnapshot(snapshot);

      expect(session.id).toBe('restored');
      expect(session.userId).toBe('user1');
      expect(session.events).toHaveLength(2);
      expect(session.state.restored).toBe(true);
      expect(session.state.user.pref).toBe('dark');
      expect(session.state.patient.condition).toBe('stable');
    });
  });
});

describe('createTestSession helper', () => {
  test('creates session with message', () => {
    const session = createTestSession('Hello');
    expect(session.id).toBe('test-session');
    expect(session.events).toHaveLength(1);
    expect(session.events[0]).toMatchObject({ type: 'user', text: 'Hello' });
  });

  test('creates session without message', () => {
    const session = createTestSession();
    expect(session.events).toHaveLength(0);
  });

  test('accepts custom options', () => {
    const session = createTestSession('Hi', {
      id: 'custom',
      userId: 'user1',
      patientId: 'patient1',
    });
    expect(session.id).toBe('custom');
    expect(session.userId).toBe('user1');
    expect(session.patientId).toBe('patient1');
  });
});

describe('session status with input yields', () => {
  test('returns awaiting_input when there is an unresolved input yield', () => {
    const session = new BaseSession('app', { id: 'test' });
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      kind: 'agent',
    });
    session.pushEvent({
      id: '2',
      type: 'invocation_yield',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      pendingCallIds: [],
      yieldIndex: 0,
      awaitingInput: true,
    });

    expect(session.status).toBe('awaiting_input');
  });

  test('returns active after input yield is resumed', () => {
    const session = new BaseSession('app', { id: 'test' });
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      kind: 'agent',
    });
    session.pushEvent({
      id: '2',
      type: 'invocation_yield',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      pendingCallIds: [],
      yieldIndex: 0,
      awaitingInput: true,
    });
    session.pushEvent({
      id: '3',
      type: 'invocation_resume',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      yieldIndex: 0,
    });

    expect(session.status).toBe('active');
  });

  test('distinguishes input yield from tool yield', () => {
    const session = new BaseSession('app', { id: 'test' });
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      kind: 'agent',
    });
    session.pushEvent({
      id: '2',
      type: 'invocation_yield',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      pendingCallIds: [],
      yieldIndex: 0,
      awaitingInput: false,
    });

    expect(session.status).toBe('active');
  });
});
