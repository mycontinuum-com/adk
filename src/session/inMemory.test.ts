import type { SessionService } from '../types'

import { setupAdkMatchers } from '../testing'
import { BaseSession } from './base'
import { InMemoryStore } from './memory'
import { sessionService } from './service'

await setupAdkMatchers()
describe('sessionService(InMemoryStore)', () => {
  let service: SessionService

  beforeEach(() => {
    service = sessionService(new InMemoryStore())
  })

  describe('createSession', () => {
    test('creates session with auto-generated ID', async () => {
      const session = await service.createSession('app', {
        scopes: { user: 'user1' },
      })
      expect(session.id).toBeUuid()
      expect(session.scopes.user).toBe('user1')
    })

    test('creates session with provided ID', async () => {
      const session = await service.createSession('app', {
        scopes: { user: 'user1' },
        sessionId: 'custom-id',
      })
      expect(session.id).toBe('session_custom-id')
    })

    test('creates session with initial state', async () => {
      const session = await service.createSession('app', {
        scopes: { user: 'user1' },
      })
      session.state.mode = 'debug'
      expect(session.state.mode).toBe('debug')
    })

    test('creates session with all scopes', async () => {
      await service.setScopedState('app', 'patient', 'patient1', {
        allergy: 'peanuts',
      })
      await service.setScopedState('app', 'practice', 'practice1', {
        timezone: 'EST',
      })

      const session = await service.createSession('app', {
        scopes: { user: 'user1', patient: 'patient1', practice: 'practice1' },
      })

      expect(session.scopes.patient).toBe('patient1')
      expect(session.scopes.practice).toBe('practice1')
      expect(session.state.patient.allergy).toBe('peanuts')
      expect(session.state.practice.timezone).toBe('EST')
    })

    test('creates session with all options', async () => {
      await service.setScopedState('app', 'user', 'user1', { theme: 'dark' })
      await service.setScopedState('app', 'patient', 'patient1', {
        condition: 'stable',
      })
      await service.setScopedState('app', 'practice', 'practice1', {
        tier: 'premium',
      })

      const session = await service.createSession('app', {
        sessionId: 'session1',
        scopes: { user: 'user1', patient: 'patient1', practice: 'practice1' },
      })
      session.state.mode = 'active'

      expect(session.id).toBe('session_session1')
      expect(session.scopes.user).toBe('user1')
      expect(session.scopes.patient).toBe('patient1')
      expect(session.scopes.practice).toBe('practice1')
      expect(session.state.mode).toBe('active')
      expect(session.state.user.theme).toBe('dark')
      expect(session.state.patient.condition).toBe('stable')
      expect(session.state.practice.tier).toBe('premium')
    })

    test('binds user state automatically', async () => {
      const session1 = (await service.createSession('app', {
        scopes: { user: 'user1' },
      })) as BaseSession
      session1.state.user.preference = 'dark'

      await service.commitSession(session1)

      const session2 = await service.createSession('app', {
        scopes: { user: 'user1' },
      })
      expect(session2.state.user.preference).toBe('dark')
    })

    test('creates session without scopes for background runnables', async () => {
      const session = await service.createSession('app')
      expect(session.id).toBeUuid()
      expect(session.scopes).toEqual({})
    })

    test('session without user scope has in-memory-only state (not persisted)', async () => {
      const session = await service.createSession('app')
      session.state.user.key = 'value'
      expect(session.state.user.key).toBe('value')

      const loaded = await service.getSession('app', session.id)
      expect(loaded!.state.user.key).toBeUndefined()
    })
  })

  describe('getSession', () => {
    test('retrieves existing session after commit', async () => {
      const created = await service.createSession('app', {
        scopes: { user: 'user1' },
        sessionId: 'session1',
      })
      ;(created as BaseSession).input.message('Hello')
      await service.commitSession(created)

      const retrieved = await service.getSession('app', 'session1')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe('session_session1')
      expect(retrieved!.events).toHaveLength(1)
    })

    test('returns null for non-existent session', async () => {
      const session = await service.getSession('app', 'missing')
      expect(session).toBeNull()
    })
  })

  describe('deleteSession', () => {
    test('deletes session', async () => {
      await service.createSession('app', {
        scopes: { user: 'user1' },
        sessionId: 'session1',
      })
      await service.deleteSession('app', 'session1')

      const session = await service.getSession('app', 'session1')
      expect(session).toBeNull()
    })

    test('does not throw for non-existent session', async () => {
      await expect(service.deleteSession('app', 'missing')).resolves.toBeUndefined()
    })
  })

  describe('appendEvent', () => {
    test('appends event to session in memory', async () => {
      const session = (await service.createSession('app', {
        scopes: { user: 'user1' },
        sessionId: 'session1',
      })) as BaseSession

      await service.appendEvent(session, {
        id: 'event1',
        type: 'user',
        createdAt: Date.now(),
        text: 'Hello',
      })

      expect(session.events).toHaveLength(1)
    })
  })

  describe('commitSession', () => {
    test('persists session events to store', async () => {
      const session = (await service.createSession('app', {
        sessionId: 'commit-test',
      })) as BaseSession

      session.input.message('Hello')
      await service.commitSession(session)

      const loaded = await service.getSession('app', 'commit-test')
      expect(loaded!.events).toHaveLength(1)
    })

    test('updates session version after commit', async () => {
      const session = await service.createSession('app')
      const v1 = session.version

      ;(session as BaseSession).input.message('Hello')
      await service.commitSession(session)

      expect(session.version).toBeDefined()
      expect(typeof session.version).toBe('number')
      expect(session.version).toBeGreaterThan(0)
      expect(session.version).not.toBe(v1)
    })

    test('flushes dirty scoped state', async () => {
      const session = await service.createSession('app', {
        scopes: { user: 'user1' },
      })
      session.state.user.pref = 'dark'
      await service.commitSession(session)

      const userState = await service.getScopedState('app', 'user', 'user1')
      expect(userState.pref).toBe('dark')
    })
  })

  describe('scoped state management', () => {
    test('getScopedState returns empty object for new scope', async () => {
      const state = await service.getScopedState('app', 'user', 'user1')
      expect(state).toEqual({})
    })

    test('setScopedState and getScopedState work together', async () => {
      await service.setScopedState('app', 'user', 'user1', {
        theme: 'dark',
        lang: 'en',
      })
      const state = await service.getScopedState('app', 'user', 'user1')
      expect(state).toEqual({ theme: 'dark', lang: 'en' })
    })

    test('user state persists across sessions via commit', async () => {
      const session1 = (await service.createSession('app', {
        scopes: { user: 'user1' },
      })) as BaseSession
      session1.state.user.preference = 'compact'
      await service.commitSession(session1)

      const session2 = (await service.createSession('app', {
        scopes: { user: 'user1' },
      })) as BaseSession
      expect(session2.state.user.preference).toBe('compact')
    })

    test('patient scoped state', async () => {
      const state0 = await service.getScopedState('app', 'patient', 'patient1')
      expect(state0).toEqual({})

      await service.setScopedState('app', 'patient', 'patient1', {
        allergies: ['penicillin'],
      })
      const state = await service.getScopedState('app', 'patient', 'patient1')
      expect(state).toEqual({ allergies: ['penicillin'] })
    })

    test('bindSessionScope binds scoped state', async () => {
      await service.setScopedState('app', 'patient', 'patient1', {
        history: 'diabetes',
      })

      const session = (await service.createSession('app', {
        scopes: { user: 'user1' },
      })) as BaseSession
      await service.bindSessionScope!(session, 'patient', 'patient1')

      expect(session.scopes.patient).toBe('patient1')
      expect(session.state.patient.history).toBe('diabetes')
    })

    test('bindSessionScope binds user state to session without user scope', async () => {
      await service.setScopedState('app', 'user', 'user1', { theme: 'dark' })

      const session = (await service.createSession('app')) as BaseSession
      expect(session.scopes.user).toBeUndefined()

      await service.bindSessionScope!(session, 'user', 'user1')

      expect(session.scopes.user).toBe('user1')
      expect(session.state.user.theme).toBe('dark')
    })

    test('patient state modifications persist via commit', async () => {
      const session1 = (await service.createSession('app', {
        scopes: { user: 'user1' },
      })) as BaseSession
      await service.bindSessionScope!(session1, 'patient', 'patient1')
      session1.state.patient.condition = 'stable'
      await service.commitSession(session1)

      const session2 = (await service.createSession('app', {
        scopes: { user: 'user2' },
      })) as BaseSession
      await service.bindSessionScope!(session2, 'patient', 'patient1')
      expect(session2.state.patient.condition).toBe('stable')
    })

    test('practice scoped state', async () => {
      const state0 = await service.getScopedState('app', 'practice', 'practice1')
      expect(state0).toEqual({})

      await service.setScopedState('app', 'practice', 'practice1', {
        timezone: 'UTC',
      })
      const state = await service.getScopedState('app', 'practice', 'practice1')
      expect(state).toEqual({ timezone: 'UTC' })
    })

    test('bindSessionScope binds practice state', async () => {
      await service.setScopedState('app', 'practice', 'practice1', {
        tier: 'premium',
      })

      const session = (await service.createSession('app', {
        scopes: { user: 'user1' },
      })) as BaseSession
      await service.bindSessionScope!(session, 'practice', 'practice1')

      expect(session.scopes.practice).toBe('practice1')
      expect(session.state.practice.tier).toBe('premium')
    })
  })

  describe('isolation between apps', () => {
    test('sessions are isolated by app name', async () => {
      await service.createSession('app1', {
        scopes: { user: 'user1' },
        sessionId: 'session1',
      })
      await service.createSession('app2', {
        scopes: { user: 'user1' },
        sessionId: 'session1',
      })

      const session1 = await service.getSession('app1', 'session1')
      const session2 = await service.getSession('app2', 'session1')

      expect(session1).not.toBe(session2)
    })

    test('scoped state is isolated by app name', async () => {
      await service.setScopedState('app1', 'user', 'user1', {
        setting: 'app1-value',
      })
      await service.setScopedState('app2', 'user', 'user1', {
        setting: 'app2-value',
      })

      expect(await service.getScopedState('app1', 'user', 'user1')).toEqual({
        setting: 'app1-value',
      })
      expect(await service.getScopedState('app2', 'user', 'user1')).toEqual({
        setting: 'app2-value',
      })
    })
  })
})
