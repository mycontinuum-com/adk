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
      const state = original.createBoundState('test-inv');
      state.session.set('key', 'value');

      const cloned = original.clone();

      expect(cloned.id).toBe(original.id);
      expect(cloned.userId).toBe(original.userId);
      expect(cloned.events).toHaveLength(original.events.length);
      expect(cloned.events).not.toBe(original.events);
      expect(cloned.createBoundState('test-inv').session.get('key')).toBe(
        'value',
      );
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
    test('set and get state values via bound state', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      state.session.set('key', 'value');
      expect(state.session.get('key')).toBe('value');
    });

    test('get returns undefined for missing keys', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      expect(state.session.get('missing')).toBeUndefined();
    });

    test('update sets multiple values', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      state.session.update({ a: 1, b: 2, c: 3 });

      expect(state.session.get('a')).toBe(1);
      expect(state.session.get('b')).toBe(2);
      expect(state.session.get('c')).toBe(3);
    });

    test('delete removes values', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      state.session.set('key', 'value');
      state.session.delete('key');

      expect(state.session.get('key')).toBeUndefined();
    });

    test('toObject returns state snapshot', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      state.session.update({ a: 1, b: 'two' });

      expect(state.session.toObject()).toEqual({ a: 1, b: 'two' });
    });

    test('state changes create events', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      state.session.set('key', 'value');

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'session',
        source: 'mutation',
        changes: [{ key: 'key', oldValue: undefined, newValue: 'value' }],
      });
    });

    test('no event when setting same value', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      state.session.set('key', 'value');
      state.session.set('key', 'value');

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(1);
    });

    test('state is computed from events (event-sourced)', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('test-inv');
      state.session.set('a', 1);
      state.session.set('b', 2);
      state.session.set('a', 10);
      state.session.delete('b');

      expect(state.session.toObject()).toEqual({ a: 10 });
    });

    test('unbound session.state throws on write', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(() => session.state.session.set('key', 'value')).toThrow(
        'Cannot modify session state without invocationId',
      );
    });

    test('unbound session.state.session throws on all write methods', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(() => session.state.session.set('key', 'value')).toThrow();
      expect(() => session.state.session.update({ key: 'value' })).toThrow();
      expect(() => session.state.session.delete('key')).toThrow();
    });

    test('unbound session.state.session allows read operations', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('init');
      state.session.set('key', 'value');

      expect(session.state.session.get('key')).toBe('value');
      expect(session.state.session.toObject()).toEqual({ key: 'value' });
      expect(session.state.session.getMany(['key'])).toEqual({ key: 'value' });
    });
  });

  describe('temp state', () => {
    test('temp state is scoped to invocation via createBoundState', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state1 = session.createBoundState('inv-1');
      state1.temp.set('key', 'value');
      expect(state1.temp.get('key')).toBe('value');

      const state2 = session.createBoundState('inv-2');
      expect(state2.temp.get('key')).toBeUndefined();

      expect(state1.temp.get('key')).toBe('value');
    });

    test('temp state is not logged as events', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('inv-1');
      state.temp.set('key', 'value');

      const stateEvents = session.events.filter(
        (e) => e.type === 'state_change',
      );
      expect(stateEvents).toHaveLength(0);
    });

    test('clearTempState clears specific invocation scope', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state = session.createBoundState('inv-1');
      state.temp.set('key', 'value');
      expect(state.temp.get('key')).toBe('value');

      session.clearTempState('inv-1');
      expect(state.temp.get('key')).toBeUndefined();
    });

    test('clearTempState without invocationId clears all scopes', () => {
      const session = new BaseSession('app', { id: 'test' });
      const state1 = session.createBoundState('inv-1');
      state1.temp.set('key1', 'value1');
      const state2 = session.createBoundState('inv-2');
      state2.temp.set('key2', 'value2');

      session.clearTempState();

      expect(state1.temp.get('key1')).toBeUndefined();
      expect(state2.temp.get('key2')).toBeUndefined();
    });

    test('inheritTempState copies parent state to child', () => {
      const session = new BaseSession('app', { id: 'test' });
      const parentState = session.createBoundState('parent');
      parentState.temp.set('shared', 'data');
      parentState.temp.set('config', 'value');

      session.inheritTempState('parent', 'child');

      const childState = session.createBoundState('child');
      expect(childState.temp.get('shared')).toBe('data');
      expect(childState.temp.get('config')).toBe('value');
    });

    test('inheritTempState merges overrides on top of parent state', () => {
      const session = new BaseSession('app', { id: 'test' });
      const parentState = session.createBoundState('parent');
      parentState.temp.set('shared', 'data');
      parentState.temp.set('config', 'original');

      session.inheritTempState('parent', 'child', {
        config: 'overridden',
        extra: 'new',
      });

      const childState = session.createBoundState('child');
      expect(childState.temp.get('shared')).toBe('data');
      expect(childState.temp.get('config')).toBe('overridden');
      expect(childState.temp.get('extra')).toBe('new');
    });

    test('child modifications do not affect parent', () => {
      const session = new BaseSession('app', { id: 'test' });
      const parentState = session.createBoundState('parent');
      parentState.temp.set('shared', 'original');

      session.inheritTempState('parent', 'child');

      const childState = session.createBoundState('child');
      childState.temp.set('shared', 'modified');

      expect(parentState.temp.get('shared')).toBe('original');
    });

    test('unbound session.state.temp throws error', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(() => session.state.temp.toObject()).toThrow(
        'Cannot access temp state without invocationId',
      );
    });

    test('unbound session.state.temp throws on all access methods', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(() => session.state.temp.get('key')).toThrow();
      expect(() => session.state.temp.set('key', 'value')).toThrow();
      expect(() => session.state.temp.update({ key: 'value' })).toThrow();
      expect(() => session.state.temp.delete('key')).toThrow();
      expect(() => session.state.temp.toObject()).toThrow();
      expect(() => session.state.temp.getMany(['key'])).toThrow();
    });
  });

  describe('shared state scopes (user, patient, practice)', () => {
    test('unbound shared state returns empty', () => {
      const session = new BaseSession('app', { id: 'test' });
      expect(session.state.user.toObject()).toEqual({});
      expect(session.state.patient.toObject()).toEqual({});
      expect(session.state.practice.toObject()).toEqual({});
    });

    test('bindSharedState connects external state', () => {
      const session = new BaseSession('app', { id: 'test' });
      const userState = { preference: 'dark' };

      session.bindSharedState('user', userState);

      expect(session.state.user.get('preference')).toBe('dark');
    });

    test('shared state modifications update external reference', () => {
      const session = new BaseSession('app', { id: 'test' });
      const userState: Record<string, unknown> = {};

      session.bindSharedState('user', userState);
      const state = session.createBoundState('test-inv');
      state.user.set('preference', 'light');

      expect(userState.preference).toBe('light');
    });

    test('shared state changes create events', () => {
      const session = new BaseSession('app', { id: 'test' });
      const patientState: Record<string, unknown> = {};

      session.bindSharedState('patient', patientState);
      const state = session.createBoundState('test-inv');
      state.patient.set('diagnosis', 'diabetes');

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
      const state = session.createBoundState('test-inv');
      state.user.set('theme', 'dark');

      expect(onChange).toHaveBeenCalledWith('theme', 'dark');
    });

    test('unbound shared state throws on write', () => {
      const session = new BaseSession('app', { id: 'test' });
      session.bindSharedState('user', {});
      session.bindSharedState('patient', {});
      session.bindSharedState('practice', {});

      expect(() => session.state.user.set('k', 'v')).toThrow(
        'Cannot modify user state without invocationId',
      );
      expect(() => session.state.patient.set('k', 'v')).toThrow(
        'Cannot modify patient state without invocationId',
      );
      expect(() => session.state.practice.set('k', 'v')).toThrow(
        'Cannot modify practice state without invocationId',
      );
    });
  });

  describe('onStateChange callback', () => {
    test('callback receives state change events', () => {
      const session = new BaseSession('app', { id: 'test' });
      const callback = jest.fn();

      session.onStateChange(callback);
      const state = session.createBoundState('test-invocation');
      state.session.set('key', 'value');

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state_change',
          scope: 'session',
          source: 'mutation',
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
      const state = session.createBoundState('test-invocation');
      state.session.set('key', 'value');

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
      expect(session.state.session.get('restored')).toBe(true);
      expect(session.state.user.get('pref')).toBe('dark');
      expect(session.state.patient.get('condition')).toBe('stable');
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
