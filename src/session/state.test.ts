import { vi } from 'vitest'

import type { StateChangeEvent } from '../types'

import { BaseSession } from './base'

describe('Shared State Observation Pattern', () => {
  test('observations are logged when state is read with bound state', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { preference: 'dark', language: 'en' }
    session.bindSharedState('user', externalUserState)
    const state = session.boundState('test-invocation')

    const pref = state.user.preference
    expect(pref).toBe('dark')

    const stateEvents = session.events.filter((e) => e.type === 'state_change')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0]).toMatchObject({
      type: 'state_change',
      scope: 'user',
      source: 'observation',
      changes: [{ key: 'preference', oldValue: undefined, newValue: 'dark' }],
    })
  })

  test('repeat observations of same value do not create events', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { preference: 'dark' }
    session.bindSharedState('user', externalUserState)
    const state = session.boundState('test-invocation')

    void state.user.preference
    void state.user.preference
    void state.user.preference

    const observationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'observation',
    )
    expect(observationEvents).toHaveLength(1)
  })

  test('observations detect external state changes', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { preference: 'dark' }
    session.bindSharedState('user', externalUserState)
    const state = session.boundState('test-invocation')

    void state.user.preference

    externalUserState.preference = 'light'

    void state.user.preference

    const observationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'observation',
    )
    expect(observationEvents).toHaveLength(2)
    expect(observationEvents[0]).toMatchObject({
      changes: [{ key: 'preference', oldValue: undefined, newValue: 'dark' }],
    })
    expect(observationEvents[1]).toMatchObject({
      changes: [{ key: 'preference', oldValue: 'dark', newValue: 'light' }],
    })
  })

  test('mutations are logged when agent changes state', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { preference: 'dark' }
    session.bindSharedState('user', externalUserState)
    const state = session.boundState('test-invocation')

    state.user.preference = 'light'

    const mutationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'mutation',
    )
    expect(mutationEvents).toHaveLength(1)
    expect(mutationEvents[0]).toMatchObject({
      type: 'state_change',
      scope: 'user',
      source: 'mutation',
      changes: [{ key: 'preference', oldValue: 'dark', newValue: 'light' }],
    })
  })

  test('mutation updates lastObserved to prevent duplicate observation', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { preference: 'dark' }
    session.bindSharedState('user', externalUserState)
    const state = session.boundState('test-invocation')

    state.user.preference = 'light'

    void state.user.preference

    const events = session.events.filter((e): e is StateChangeEvent => e.type === 'state_change')
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('mutation')
  })

  test('observation and mutation work together in realistic scenario', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123', patient: 'patient456' },
    })

    const externalPatientState: Record<string, unknown> = {
      diagnosis: 'diabetes',
      lastVisit: '2024-01-01',
    }
    session.bindSharedState('patient', externalPatientState)
    const state = session.boundState('test-invocation')

    const diagnosis = state.patient.diagnosis
    expect(diagnosis).toBe('diabetes')

    externalPatientState.diagnosis = 'diabetes,hypertension'

    state.patient.medication = 'metformin'

    const diagnosis2 = state.patient.diagnosis
    expect(diagnosis2).toBe('diabetes,hypertension')

    const events = session.events.filter((e): e is StateChangeEvent => e.type === 'state_change')
    expect(events).toHaveLength(3)

    const [obs1, mut1, obs2] = events
    expect(obs1.source).toBe('observation')
    expect(obs1.changes[0].key).toBe('diagnosis')
    expect(obs1.changes[0].newValue).toBe('diabetes')

    expect(mut1.source).toBe('mutation')
    expect(mut1.changes[0].key).toBe('medication')

    expect(obs2.source).toBe('observation')
    expect(obs2.changes[0].key).toBe('diagnosis')
    expect(obs2.changes[0].oldValue).toBe('diabetes')
    expect(obs2.changes[0].newValue).toBe('diabetes,hypertension')
  })

  test('delete mutations are logged', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { preference: 'dark', theme: 'blue' }
    session.bindSharedState('user', externalUserState)
    const state = session.boundState('test-invocation')

    state.user.theme = undefined

    const mutationEvents = session.events.filter(
      (e) => e.type === 'state_change' && e.source === 'mutation',
    )
    expect(mutationEvents).toHaveLength(1)
    expect(mutationEvents[0]).toMatchObject({
      changes: [{ key: 'theme', oldValue: 'blue', newValue: undefined }],
    })
  })

  test('Object.assign logs multiple mutations', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { a: 1, b: 2 }
    session.bindSharedState('user', externalUserState)
    const state = session.boundState('test-invocation')

    Object.assign(state.user, { a: 10, c: 30 })

    const mutationEvents = session.events.filter(
      (e): e is StateChangeEvent => e.type === 'state_change' && e.source === 'mutation',
    )
    expect(mutationEvents).toHaveLength(2)
    expect(mutationEvents[0].changes[0].key).toBe('a')
    expect(mutationEvents[1].changes[0].key).toBe('c')
  })

  test('session scope changes are mutations via bound state', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })
    const state = session.boundState('test-invocation')

    state.count = 1

    const events = session.events.filter((e) => e.type === 'state_change')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      scope: 'session',
      source: 'mutation',
    })
  })

  test('direct state access uses direct source', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    session.state.count = 1

    const events = session.events.filter((e) => e.type === 'state_change')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      scope: 'session',
      source: 'direct',
    })
  })

  test('spread does not trigger observations', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    const externalUserState = { preference: 'dark', theme: 'blue' }
    session.bindSharedState('user', externalUserState)

    const snapshot = { ...session.state.user }
    expect(snapshot).toEqual({ preference: 'dark', theme: 'blue' })

    const events = session.events.filter((e) => e.type === 'state_change')
    expect(events).toHaveLength(0)
  })
})

describe('Concurrent Write Detection', () => {
  test('warns on concurrent writes from different invocations', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    session.bindSharedState('user', {})
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const state1 = session.boundState('inv-1')
    const state2 = session.boundState('inv-2')

    state1.user.key = 'value1'
    state2.user.key = 'value2'

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Concurrent write detected'))
    consoleSpy.mockRestore()
  })

  test('does not warn for writes from same invocation', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    session.bindSharedState('user', {})
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const state = session.boundState('inv-1')

    state.user.key = 'value1'
    state.user.key = 'value2'

    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  test('warns only once per key for concurrent writes', () => {
    const session = new BaseSession('test-app', {
      id: 'test-session',
      scopes: { user: 'user123' },
    })
    session.bindSharedState('user', {})
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const state1 = session.boundState('inv-1')
    const state2 = session.boundState('inv-2')

    state1.user.key = 'a'
    state2.user.key = 'b'
    state1.user.key = 'c'
    state2.user.key = 'd'

    expect(consoleSpy).toHaveBeenCalledTimes(1)
    consoleSpy.mockRestore()
  })
})

describe('Temp State Isolation', () => {
  test('temp state is isolated per invocation', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    const state1 = session.boundState('inv-1')
    const state2 = session.boundState('inv-2')

    state1.temp.scratch = 'inv1-data'
    state2.temp.scratch = 'inv2-data'

    expect(state1.temp.scratch).toBe('inv1-data')
    expect(state2.temp.scratch).toBe('inv2-data')
  })

  test('temp state is not logged as state_change events', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })
    const state = session.boundState('inv-1')

    state.temp.key1 = 'value1'
    state.temp.key2 = 'value2'

    const events = session.events.filter((e) => e.type === 'state_change')
    expect(events).toHaveLength(0)
  })

  test('clearTempState removes specific invocation temp state', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    const state1 = session.boundState('inv-1')
    const state2 = session.boundState('inv-2')

    state1.temp.data = 'keep'
    state2.temp.data = 'remove'

    session.clearTempState('inv-2')

    expect(state1.temp.data).toBe('keep')
    expect(state2.temp.data).toBeUndefined()
  })

  test('clearTempState without argument clears all temp state', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    const state1 = session.boundState('inv-1')
    const state2 = session.boundState('inv-2')

    state1.temp.data = 'data1'
    state2.temp.data = 'data2'

    session.clearTempState()

    expect(state1.temp.data).toBeUndefined()
    expect(state2.temp.data).toBeUndefined()
  })
})

describe('Temp State Inheritance', () => {
  test('child invocation inherits parent temp state', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    const parentState = session.boundState('parent')
    parentState.temp.inherited = 'from-parent'
    parentState.temp.willOverride = 'parent-value'

    session.inheritTempState('parent', 'child', { override: 'child-value' })

    const childState = session.boundState('child')
    expect(childState.temp.inherited).toBe('from-parent')
    expect(childState.temp.override).toBe('child-value')
  })

  test('inheritTempState overrides merge with parent values', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    const parentState = session.boundState('parent')
    parentState.temp.key = 'parent'

    session.inheritTempState('parent', 'child', { key: 'child' })

    const childState = session.boundState('child')
    expect(childState.temp.key).toBe('child')
  })

  test('inheritTempState from non-existent parent creates empty child', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    session.inheritTempState('nonexistent', 'child', { key: 'value' })

    const childState = session.boundState('child')
    expect(childState.temp.key).toBe('value')
  })
})

describe('Deep Equality Checks', () => {
  test('deep equal objects do not trigger events', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    session.state.data = { nested: { value: 1 } }
    const eventsBefore = session.events.length

    session.state.data = { nested: { value: 1 } }

    expect(session.events.length).toBe(eventsBefore)
  })

  test('deep equal arrays do not trigger events', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    session.state.items = [1, 2, { a: 3 }]
    const eventsBefore = session.events.length

    session.state.items = [1, 2, { a: 3 }]

    expect(session.events.length).toBe(eventsBefore)
  })

  test('structurally different objects trigger events', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    session.state.data = { nested: { value: 1 } }
    const eventsBefore = session.events.length

    session.state.data = { nested: { value: 2 } }

    expect(session.events.length).toBe(eventsBefore + 1)
  })
})

describe('Temp State Error Handling', () => {
  test('temp state throws without invocation context', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    expect(() => session.state.temp.key).toThrow('Temp state requires an invocation context')
  })

  test('temp state write throws without invocation context', () => {
    const session = new BaseSession('test-app', { id: 'test-session' })

    expect(() => {
      session.state.temp.key = 'value'
    }).toThrow('Temp state requires an invocation context')
  })
})
