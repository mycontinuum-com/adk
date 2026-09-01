import { vi } from 'vitest'

import { createTestSession, setupAdkMatchers } from '../testing'
import { BaseSession } from './base'

await setupAdkMatchers()
describe('BaseSession', () => {
  describe('construction', () => {
    test('creates session with auto-generated ID', () => {
      const session = new BaseSession('app')
      expect(session.id).toBeUuid()
      expect(session.appName).toBe('app')
      expect(session.events).toEqual([])
      expect(session.createdAt).toBeGreaterThan(0)
    })

    test('creates session with provided ID', () => {
      const session = new BaseSession('app', { id: 'custom-id' })
      expect(session.id).toBe('session_custom-id')
    })

    test('creates session with scopes', () => {
      const session = new BaseSession('app', {
        id: 's1',
        scopes: { user: 'user1', patient: 'patient1', practice: 'practice1' },
      })
      expect(session.scopes.user).toBe('user1')
      expect(session.scopes.patient).toBe('patient1')
      expect(session.scopes.practice).toBe('practice1')
    })
  })

  describe('input.message', () => {
    test('adds user message to events', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.input.message('Hello')

      expect(session.events).toHaveLength(1)
      expect(session.events[0]).toMatchObject({
        type: 'user',
        text: 'Hello',
      })
      expect(session.events[0].id).toBeUuid()
      expect(session.events[0].createdAt).toBeGreaterThan(0)
    })

    test('returns session for chaining', () => {
      const session = new BaseSession('app', { id: 'test' })
      const result = session.input.message('Hello')
      expect(result).toBe(session)
    })

    test('can chain multiple messages', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.input.message('First')
      session.input.message('Second')

      expect(session.events).toHaveLength(2)
      expect(session.events[0]).toMatchObject({ type: 'user', text: 'First' })
      expect(session.events[1]).toMatchObject({ type: 'user', text: 'Second' })
    })
  })

  describe('pushEvent', () => {
    test('pushes events to session', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.pushEvent({
        id: '1',
        type: 'system',
        createdAt: Date.now(),
        invocationId: 'test-inv',
        agentName: 'test_agent',
        text: 'System message',
      })
      session.pushEvent({
        id: '2',
        type: 'user',
        createdAt: Date.now(),
        text: 'User message',
      })

      expect(session.events).toHaveLength(2)
    })
  })

  describe('tagTrailingEvents', () => {
    test('tags unowned user events at the tail', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.pushEvent({
        id: '1',
        type: 'user',
        createdAt: Date.now(),
        text: 'Hello',
      })
      session.pushEvent({
        id: '2',
        type: 'user',
        createdAt: Date.now(),
        text: 'World',
      })

      session.tagTrailingEvents('root-inv')

      expect(session.events[0].invocationId).toBe('root-inv')
      expect(session.events[1].invocationId).toBe('root-inv')
    })

    test('stops at first event with an invocationId', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.pushEvent({
        id: '1',
        type: 'user',
        createdAt: Date.now(),
        text: 'Previous turn',
      })
      session.pushEvent({
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        text: 'Response',
        invocationId: 'old-inv',
        agentName: 'a',
      } as any)
      session.pushEvent({
        id: '3',
        type: 'user',
        createdAt: Date.now(),
        text: 'New message',
      })

      session.tagTrailingEvents('new-inv')

      expect(session.events[0].invocationId).toBeUndefined()
      expect(session.events[1].invocationId).toBe('old-inv')
      expect(session.events[2].invocationId).toBe('new-inv')
    })

    test('tags all three optional-invocationId event types', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.pushEvent({
        id: '1',
        type: 'state_change',
        createdAt: Date.now(),
        scope: 'session',
        source: 'direct',
        changes: [{ key: 'k', oldValue: undefined, newValue: 1 }],
      } as any)
      session.pushEvent({
        id: '2',
        type: 'user',
        createdAt: Date.now(),
        text: 'Hello',
      })

      session.tagTrailingEvents('root-inv')

      expect(session.events[0].invocationId).toBe('root-inv')
      expect(session.events[1].invocationId).toBe('root-inv')
    })

    test('no-op when no trailing unowned events', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.pushEvent({
        id: '1',
        type: 'assistant',
        createdAt: Date.now(),
        text: 'Hi',
        invocationId: 'inv1',
        agentName: 'a',
      } as any)

      session.tagTrailingEvents('root-inv')

      expect(session.events[0].invocationId).toBe('inv1')
    })
  })

  describe('clone', () => {
    test('creates deep copy of session', () => {
      const original = new BaseSession('app', {
        id: 'test',
        scopes: { user: 'user1', patient: 'patient1', practice: 'practice1' },
      })
      original.input.message('Hello')
      original.state.key = 'value'

      const cloned = original.clone()

      expect(cloned.id).toBe(original.id)
      expect(cloned.scopes.user).toBe(original.scopes.user)
      expect(cloned.events).toHaveLength(original.events.length)
      expect(cloned.events).not.toBe(original.events)
      expect(cloned.state.key).toBe('value')
    })

    test('cloned session events are independent', () => {
      const original = new BaseSession('app', { id: 'test' })
      original.input.message('Original')

      const cloned = original.clone()
      cloned.input.message('Cloned')

      expect(original.events).toHaveLength(1)
      expect(cloned.events).toHaveLength(2)
    })
  })

  describe('session state', () => {
    test('set and get state values via property access', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.state.key = 'value'
      expect(session.state.key).toBe('value')
    })

    test('get returns undefined for missing keys', () => {
      const session = new BaseSession('app', { id: 'test' })
      expect(session.state.missing).toBeUndefined()
    })

    test('Object.assign sets multiple values', () => {
      const session = new BaseSession('app', { id: 'test' })
      Object.assign(session.state, { a: 1, b: 2, c: 3 })

      expect(session.state.a).toBe(1)
      expect(session.state.b).toBe(2)
      expect(session.state.c).toBe(3)
    })

    test('setting undefined removes values', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.state.key = 'value'
      session.state.key = undefined

      expect(session.state.key).toBeUndefined()
    })

    test('spread returns state snapshot', () => {
      const session = new BaseSession('app', { id: 'test' })
      Object.assign(session.state, { a: 1, b: 'two' })

      expect({ ...session.state }).toEqual({ a: 1, b: 'two' })
    })

    test('direct state changes use direct source', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.state.key = 'value'

      const stateEvents = session.events.filter((e) => e.type === 'state_change')
      expect(stateEvents).toHaveLength(1)
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'session',
        source: 'direct',
        changes: [{ key: 'key', oldValue: undefined, newValue: 'value' }],
      })
    })

    test('bound state changes use mutation source', () => {
      const session = new BaseSession('app', { id: 'test' })
      const state = session.boundState('test-inv')
      state.key = 'value'

      const stateEvents = session.events.filter((e) => e.type === 'state_change')
      expect(stateEvents).toHaveLength(1)
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'session',
        source: 'mutation',
        invocationId: 'test-inv',
        changes: [{ key: 'key', oldValue: undefined, newValue: 'value' }],
      })
    })

    test('no event when setting same value', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.state.key = 'value'
      session.state.key = 'value'

      const stateEvents = session.events.filter((e) => e.type === 'state_change')
      expect(stateEvents).toHaveLength(1)
    })

    test('state is computed from events (event-sourced)', () => {
      const session = new BaseSession('app', { id: 'test' })
      session.state.a = 1
      session.state.b = 2
      session.state.a = 10
      session.state.b = undefined

      expect({ ...session.state }).toEqual({ a: 10 })
    })
  })

  describe('temp state', () => {
    test('temp state is scoped to invocation via boundState', () => {
      const session = new BaseSession('app', { id: 'test' })
      const state1 = session.boundState('inv-1')
      state1.temp.key = 'value'
      expect(state1.temp.key).toBe('value')

      const state2 = session.boundState('inv-2')
      expect(state2.temp.key).toBeUndefined()

      expect(state1.temp.key).toBe('value')
    })

    test('temp state is not logged as events', () => {
      const session = new BaseSession('app', { id: 'test' })
      const state = session.boundState('inv-1')
      state.temp.key = 'value'

      const stateEvents = session.events.filter((e) => e.type === 'state_change')
      expect(stateEvents).toHaveLength(0)
    })

    test('clearTempState clears specific invocation scope', () => {
      const session = new BaseSession('app', { id: 'test' })
      const state = session.boundState('inv-1')
      state.temp.key = 'value'
      expect(state.temp.key).toBe('value')

      session.clearTempState('inv-1')
      expect(state.temp.key).toBeUndefined()
    })

    test('clearTempState without invocationId clears all scopes', () => {
      const session = new BaseSession('app', { id: 'test' })
      const state1 = session.boundState('inv-1')
      state1.temp.key1 = 'value1'
      const state2 = session.boundState('inv-2')
      state2.temp.key2 = 'value2'

      session.clearTempState()

      expect(state1.temp.key1).toBeUndefined()
      expect(state2.temp.key2).toBeUndefined()
    })

    test('inheritTempState copies parent state to child', () => {
      const session = new BaseSession('app', { id: 'test' })
      const parentState = session.boundState('parent')
      parentState.temp.shared = 'data'
      parentState.temp.config = 'value'

      session.inheritTempState('parent', 'child')

      const childState = session.boundState('child')
      expect(childState.temp.shared).toBe('data')
      expect(childState.temp.config).toBe('value')
    })

    test('inheritTempState merges overrides on top of parent state', () => {
      const session = new BaseSession('app', { id: 'test' })
      const parentState = session.boundState('parent')
      parentState.temp.shared = 'data'
      parentState.temp.config = 'original'

      session.inheritTempState('parent', 'child', {
        config: 'overridden',
        extra: 'new',
      })

      const childState = session.boundState('child')
      expect(childState.temp.shared).toBe('data')
      expect(childState.temp.config).toBe('overridden')
      expect(childState.temp.extra).toBe('new')
    })

    test('child modifications do not affect parent', () => {
      const session = new BaseSession('app', { id: 'test' })
      const parentState = session.boundState('parent')
      parentState.temp.shared = 'original'

      session.inheritTempState('parent', 'child')

      const childState = session.boundState('child')
      childState.temp.shared = 'modified'

      expect(parentState.temp.shared).toBe('original')
    })

    test('session.state.temp throws without invocation context', () => {
      const session = new BaseSession('app', { id: 'test' })
      expect(() => ({ ...session.state.temp })).toThrow('Temp state requires an invocation context')
    })

    test('session.state.temp throws on property access', () => {
      const session = new BaseSession('app', { id: 'test' })
      expect(() => session.state.temp.key).toThrow()
      expect(() => {
        session.state.temp.key = 'value'
      }).toThrow()
    })
  })

  describe('shared state scopes (user, patient, practice)', () => {
    test('unbound shared state returns empty', () => {
      const session = new BaseSession('app', { id: 'test' })
      expect({ ...session.state.user }).toEqual({})
      expect({ ...session.state.patient }).toEqual({})
      expect({ ...session.state.practice }).toEqual({})
    })

    test('bindSharedState connects external state', () => {
      const session = new BaseSession('app', { id: 'test' })
      const userState = { preference: 'dark' }

      session.bindSharedState('user', userState)

      expect(session.state.user.preference).toBe('dark')
    })

    test('direct shared state modifications update external reference', () => {
      const session = new BaseSession('app', { id: 'test' })
      const userState: Record<string, unknown> = {}

      session.bindSharedState('user', userState)
      session.state.user.preference = 'light'

      expect(userState.preference).toBe('light')
    })

    test('direct shared state changes use direct source', () => {
      const session = new BaseSession('app', { id: 'test' })
      const patientState: Record<string, unknown> = {}

      session.bindSharedState('patient', patientState)
      session.state.patient.diagnosis = 'diabetes'

      const stateEvents = session.events.filter((e) => e.type === 'state_change')
      expect(stateEvents).toHaveLength(1)
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'patient',
        source: 'direct',
        changes: [{ key: 'diagnosis', oldValue: undefined, newValue: 'diabetes' }],
      })
    })

    test('bound shared state changes use mutation source', () => {
      const session = new BaseSession('app', { id: 'test' })
      const patientState: Record<string, unknown> = {}

      session.bindSharedState('patient', patientState)
      session.boundState('test-inv').patient.diagnosis = 'diabetes'

      const stateEvents = session.events.filter((e) => e.type === 'state_change')
      expect(stateEvents).toHaveLength(1)
      expect(stateEvents[0]).toMatchObject({
        type: 'state_change',
        scope: 'patient',
        source: 'mutation',
        invocationId: 'test-inv',
        changes: [{ key: 'diagnosis', oldValue: undefined, newValue: 'diabetes' }],
      })
    })

    test('onChange callback is invoked on state change', () => {
      const session = new BaseSession('app', { id: 'test' })
      const userState: Record<string, unknown> = {}
      const onChange = vi.fn<(...args: unknown[]) => unknown>()

      session.bindSharedState('user', userState, onChange)
      session.state.user.theme = 'dark'

      expect(onChange).toHaveBeenCalledWith('theme', 'dark')
    })
  })

  describe('onStateChange callback', () => {
    test('callback receives state change events', () => {
      const session = new BaseSession('app', { id: 'test' })
      const callback = vi.fn<(...args: unknown[]) => unknown>()

      session.onStateChange(callback)
      session.state.key = 'value'

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state_change',
          scope: 'session',
          source: 'direct',
          changes: [{ key: 'key', oldValue: undefined, newValue: 'value' }],
        }),
      )
    })
  })

  describe('toJSON', () => {
    test('serializes session to JSON-compatible object', () => {
      const session = new BaseSession('app', {
        id: 'test',
        scopes: { user: 'user1', patient: 'patient1', practice: 'practice1' },
      })
      session.input.message('Hello')
      session.state.key = 'value'

      const json = session.toJSON()

      expect(json.id).toBe('session_test')
      expect(json.scopes).toEqual({
        user: 'user1',
        patient: 'patient1',
        practice: 'practice1',
      })
      expect(json.events).toHaveLength(2)
      expect(json.state).toEqual({ key: 'value' })
    })
  })

  describe('fromSnapshot', () => {
    test('restores session from snapshot', () => {
      const snapshot = {
        appName: 'app',
        id: 'restored',
        scopes: { user: 'user1', patient: 'patient1', practice: 'practice1' },
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
        scopedStates: {
          user: { pref: 'dark' },
          patient: { condition: 'stable' },
        },
      }

      const session = BaseSession.fromSnapshot(snapshot)

      expect(session.id).toBe('session_restored')
      expect(session.scopes.user).toBe('user1')
      expect(session.events).toHaveLength(2)
      expect(session.state.restored).toBe(true)
      expect(session.state.user.pref).toBe('dark')
      expect(session.state.patient.condition).toBe('stable')
    })
  })
})

describe('createTestSession helper', () => {
  test('creates session with message', () => {
    const session = createTestSession('Hello')
    expect(session.id).toBe('session_test-session')
    expect(session.events).toHaveLength(1)
    expect(session.events[0]).toMatchObject({ type: 'user', text: 'Hello' })
  })

  test('creates session without message', () => {
    const session = createTestSession()
    expect(session.events).toHaveLength(0)
  })

  test('accepts custom options', () => {
    const session = createTestSession('Hi', {
      id: 'custom',
      scopes: { user: 'user1', patient: 'patient1' },
    })
    expect(session.id).toBe('session_custom')
    expect(session.scopes.user).toBe('user1')
    expect(session.scopes.patient).toBe('patient1')
  })
})

describe('session status with input yields', () => {
  test('returns awaiting_input when there is an unresolved input yield', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      kind: 'agent',
    })
    session.pushEvent({
      id: '2',
      type: 'invocation_yield',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      yieldedToolIds: [],
      yieldIndex: 0,
      awaitingInput: true,
    })

    expect(session.status).toBe('awaiting_input')
  })

  test('returns active after input yield is resumed', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      kind: 'agent',
    })
    session.pushEvent({
      id: '2',
      type: 'invocation_yield',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      yieldedToolIds: [],
      yieldIndex: 0,
      awaitingInput: true,
    })
    session.pushEvent({
      id: '3',
      type: 'invocation_resume',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      yieldIndex: 0,
    })

    expect(session.status).toBe('active')
  })

  test('distinguishes input yield from tool yield', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      kind: 'agent',
    })
    session.pushEvent({
      id: '2',
      type: 'invocation_yield',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'loop',
      yieldedToolIds: [],
      yieldIndex: 0,
      awaitingInput: false,
    })

    expect(session.status).toBe('active')
  })
})
