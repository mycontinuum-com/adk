import { BaseSession } from './base';
import type { StateChangeEvent } from '../types';

describe('Shared State Observation Pattern', () => {
  test('observations are logged when state is read with bound state', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { preference: 'dark', language: 'en' };
    session.bindSharedState('user', externalUserState);
    const state = session.boundState('test-invocation');

    const pref = state.user.preference;
    expect(pref).toBe('dark');

    const stateEvents = session.events.filter((e) => e.type === 'state_change');
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0]).toMatchObject({
      type: 'state_change',
      scope: 'user',
      source: 'observation',
      changes: [{ key: 'preference', oldValue: undefined, newValue: 'dark' }],
    });
  });

  test('repeat observations of same value do not create events', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { preference: 'dark' };
    session.bindSharedState('user', externalUserState);
    const state = session.boundState('test-invocation');

    void state.user.preference;
    void state.user.preference;
    void state.user.preference;

    const observationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'observation',
    );
    expect(observationEvents).toHaveLength(1);
  });

  test('observations detect external state changes', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { preference: 'dark' };
    session.bindSharedState('user', externalUserState);
    const state = session.boundState('test-invocation');

    void state.user.preference;

    externalUserState.preference = 'light';

    void state.user.preference;

    const observationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'observation',
    );
    expect(observationEvents).toHaveLength(2);
    expect(observationEvents[0]).toMatchObject({
      changes: [{ key: 'preference', oldValue: undefined, newValue: 'dark' }],
    });
    expect(observationEvents[1]).toMatchObject({
      changes: [{ key: 'preference', oldValue: 'dark', newValue: 'light' }],
    });
  });

  test('mutations are logged when agent changes state', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { preference: 'dark' };
    session.bindSharedState('user', externalUserState);
    const state = session.boundState('test-invocation');

    state.user.preference = 'light';

    const mutationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'mutation',
    );
    expect(mutationEvents).toHaveLength(1);
    expect(mutationEvents[0]).toMatchObject({
      type: 'state_change',
      scope: 'user',
      source: 'mutation',
      changes: [{ key: 'preference', oldValue: 'dark', newValue: 'light' }],
    });
  });

  test('mutation updates lastObserved to prevent duplicate observation', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { preference: 'dark' };
    session.bindSharedState('user', externalUserState);
    const state = session.boundState('test-invocation');

    state.user.preference = 'light';

    void state.user.preference;

    const events = session.events.filter(
      (e): e is StateChangeEvent => e.type === 'state_change',
    );
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('mutation');
  });

  test('observation and mutation work together in realistic scenario', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
      patientId: 'patient456',
    });

    const externalPatientState: Record<string, unknown> = {
      diagnosis: 'diabetes',
      lastVisit: '2024-01-01',
    };
    session.bindSharedState('patient', externalPatientState);
    const state = session.boundState('test-invocation');

    const diagnosis = state.patient.diagnosis;
    expect(diagnosis).toBe('diabetes');

    externalPatientState.diagnosis = 'diabetes,hypertension';

    state.patient.medication = 'metformin';

    const diagnosis2 = state.patient.diagnosis;
    expect(diagnosis2).toBe('diabetes,hypertension');

    const events = session.events.filter(
      (e): e is StateChangeEvent => e.type === 'state_change',
    );
    expect(events).toHaveLength(3);

    const [obs1, mut1, obs2] = events;
    expect(obs1.source).toBe('observation');
    expect(obs1.changes[0].key).toBe('diagnosis');
    expect(obs1.changes[0].newValue).toBe('diabetes');

    expect(mut1.source).toBe('mutation');
    expect(mut1.changes[0].key).toBe('medication');

    expect(obs2.source).toBe('observation');
    expect(obs2.changes[0].key).toBe('diagnosis');
    expect(obs2.changes[0].oldValue).toBe('diabetes');
    expect(obs2.changes[0].newValue).toBe('diabetes,hypertension');
  });

  test('delete mutations are logged', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { preference: 'dark', theme: 'blue' };
    session.bindSharedState('user', externalUserState);
    const state = session.boundState('test-invocation');

    state.user.theme = undefined;

    const mutationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'mutation',
    );
    expect(mutationEvents).toHaveLength(1);
    expect(mutationEvents[0]).toMatchObject({
      changes: [{ key: 'theme', oldValue: 'blue', newValue: undefined }],
    });
  });

  test('Object.assign logs multiple mutations', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { a: 1, b: 2 };
    session.bindSharedState('user', externalUserState);
    const state = session.boundState('test-invocation');

    Object.assign(state.user, { a: 10, c: 30 });

    const mutationEvents = session.events.filter(
      (e): e is StateChangeEvent =>
        e.type === 'state_change' && e.source === 'mutation',
    );
    expect(mutationEvents).toHaveLength(2);
    expect(mutationEvents[0].changes[0].key).toBe('a');
    expect(mutationEvents[1].changes[0].key).toBe('c');
  });

  test('session scope changes are mutations via bound state', () => {
    const session = new BaseSession('test-app', { id: 'test-session' });
    const state = session.boundState('test-invocation');

    state.count = 1;

    const events = session.events.filter((e) => e.type === 'state_change');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'session',
      source: 'mutation',
    });
  });

  test('direct state access uses direct source', () => {
    const session = new BaseSession('test-app', { id: 'test-session' });

    session.state.count = 1;

    const events = session.events.filter((e) => e.type === 'state_change');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'session',
      source: 'direct',
    });
  });

  test('spread does not trigger observations', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      userId: 'user123',
    });
    const externalUserState = { preference: 'dark', theme: 'blue' };
    session.bindSharedState('user', externalUserState);

    const snapshot = { ...session.state.user };
    expect(snapshot).toEqual({ preference: 'dark', theme: 'blue' });

    const events = session.events.filter((e) => e.type === 'state_change');
    expect(events).toHaveLength(0);
  });
});
