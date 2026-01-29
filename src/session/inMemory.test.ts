import { InMemorySessionService } from './inMemory';
import { BaseSession } from './base';
import { setupAdkMatchers } from '../testing';

setupAdkMatchers();

describe('InMemorySessionService', () => {
  let service: InMemorySessionService;

  beforeEach(() => {
    service = new InMemorySessionService();
  });

  describe('createSession', () => {
    test('creates session with auto-generated ID', async () => {
      const session = await service.createSession('app', { userId: 'user1' });
      expect(session.id).toBeUuid();
      expect(session.userId).toBe('user1');
    });

    test('creates session with provided ID', async () => {
      const session = await service.createSession('app', {
        userId: 'user1',
        sessionId: 'custom-id',
      });
      expect(session.id).toBe('custom-id');
    });

    test('creates session with initial state', async () => {
      const session = await service.createSession('app', {
        userId: 'user1',
        initialState: { mode: 'debug' },
      });
      expect(session.state.session.get('mode')).toBe('debug');
    });

    test('creates session with patientId and practiceId', async () => {
      await service.setPatientState('app', 'patient1', { allergy: 'peanuts' });
      await service.setPracticeState('app', 'practice1', { timezone: 'EST' });

      const session = await service.createSession('app', {
        userId: 'user1',
        patientId: 'patient1',
        practiceId: 'practice1',
      });

      expect(session.patientId).toBe('patient1');
      expect(session.practiceId).toBe('practice1');
      expect(session.state.patient.get('allergy')).toBe('peanuts');
      expect(session.state.practice.get('timezone')).toBe('EST');
    });

    test('creates session with all options', async () => {
      await service.setUserState('app', 'user1', { theme: 'dark' });
      await service.setPatientState('app', 'patient1', { condition: 'stable' });
      await service.setPracticeState('app', 'practice1', { tier: 'premium' });

      const session = await service.createSession('app', {
        sessionId: 'session1',
        userId: 'user1',
        patientId: 'patient1',
        practiceId: 'practice1',
        initialState: { mode: 'active' },
      });

      expect(session.id).toBe('session1');
      expect(session.userId).toBe('user1');
      expect(session.patientId).toBe('patient1');
      expect(session.practiceId).toBe('practice1');
      expect(session.state.session.get('mode')).toBe('active');
      expect(session.state.user.get('theme')).toBe('dark');
      expect(session.state.patient.get('condition')).toBe('stable');
      expect(session.state.practice.get('tier')).toBe('premium');
    });

    test('binds user state automatically', async () => {
      const session1 = (await service.createSession('app', {
        userId: 'user1',
      })) as BaseSession;
      session1.createBoundState('test-inv').user.set('preference', 'dark');

      const session2 = await service.createSession('app', { userId: 'user1' });
      expect(session2.state.user.get('preference')).toBe('dark');
    });

    test('creates session without userId for background runnables', async () => {
      const session = await service.createSession('app');
      expect(session.id).toBeUuid();
      expect(session.userId).toBeUndefined();
    });

    test('session without userId has no-op user state accessor', async () => {
      const session = await service.createSession('app');
      session.state.user.set('key', 'value');
      expect(session.state.user.get('key')).toBeUndefined();
    });
  });

  describe('getSession', () => {
    test('retrieves existing session', async () => {
      const created = await service.createSession('app', {
        userId: 'user1',
        sessionId: 'session1',
      });
      (created as BaseSession).addMessage('Hello');

      const retrieved = await service.getSession('app', 'session1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('session1');
      expect(retrieved!.events).toHaveLength(1);
    });

    test('returns null for non-existent session', async () => {
      const session = await service.getSession('app', 'missing');
      expect(session).toBeNull();
    });
  });

  describe('deleteSession', () => {
    test('deletes session', async () => {
      await service.createSession('app', {
        userId: 'user1',
        sessionId: 'session1',
      });
      await service.deleteSession('app', 'session1');

      const session = await service.getSession('app', 'session1');
      expect(session).toBeNull();
    });

    test('does not throw for non-existent session', async () => {
      await expect(
        service.deleteSession('app', 'missing'),
      ).resolves.toBeUndefined();
    });
  });

  describe('appendEvent', () => {
    test('appends event to session', async () => {
      const session = (await service.createSession('app', {
        userId: 'user1',
        sessionId: 'session1',
      })) as BaseSession;

      await service.appendEvent(session, {
        id: 'event1',
        type: 'user',
        createdAt: Date.now(),
        text: 'Hello',
      });

      expect(session.events).toHaveLength(1);
    });
  });

  describe('user state management', () => {
    test('getUserState returns empty object for new user', async () => {
      const state = await service.getUserState('app', 'user1');
      expect(state).toEqual({});
    });

    test('setUserState and getUserState work together', async () => {
      await service.setUserState('app', 'user1', { theme: 'dark', lang: 'en' });
      const state = await service.getUserState('app', 'user1');
      expect(state).toEqual({ theme: 'dark', lang: 'en' });
    });

    test('user state persists across sessions', async () => {
      const session1 = (await service.createSession('app', {
        userId: 'user1',
      })) as BaseSession;
      session1.createBoundState('test-inv').user.set('preference', 'compact');

      const session2 = (await service.createSession('app', {
        userId: 'user1',
      })) as BaseSession;
      expect(session2.state.user.get('preference')).toBe('compact');
    });
  });

  describe('patient state management', () => {
    test('getPatientState returns empty object for new patient', async () => {
      const state = await service.getPatientState('app', 'patient1');
      expect(state).toEqual({});
    });

    test('setPatientState and getPatientState work together', async () => {
      await service.setPatientState('app', 'patient1', {
        allergies: ['penicillin'],
      });
      const state = await service.getPatientState('app', 'patient1');
      expect(state).toEqual({ allergies: ['penicillin'] });
    });

    test('bindSessionScope binds patient state', async () => {
      await service.setPatientState('app', 'patient1', { history: 'diabetes' });

      const session = (await service.createSession('app', {
        userId: 'user1',
      })) as BaseSession;
      service.bindSessionScope(session, 'patient', 'patient1');

      expect(session.patientId).toBe('patient1');
      expect(session.state.patient.get('history')).toBe('diabetes');
    });

    test('bindSessionScope binds user state to session without userId', async () => {
      await service.setUserState('app', 'user1', { theme: 'dark' });

      const session = (await service.createSession('app')) as BaseSession;
      expect(session.userId).toBeUndefined();

      service.bindSessionScope(session, 'user', 'user1');

      expect(session.userId).toBe('user1');
      expect(session.state.user.get('theme')).toBe('dark');
    });

    test('patient state modifications persist', async () => {
      const session1 = (await service.createSession('app', {
        userId: 'user1',
      })) as BaseSession;
      service.bindSessionScope(session1, 'patient', 'patient1');
      session1.createBoundState('test-inv').patient.set('condition', 'stable');

      const session2 = (await service.createSession('app', {
        userId: 'user2',
      })) as BaseSession;
      service.bindSessionScope(session2, 'patient', 'patient1');
      expect(session2.state.patient.get('condition')).toBe('stable');
    });
  });

  describe('practice state management', () => {
    test('getPracticeState returns empty object for new practice', async () => {
      const state = await service.getPracticeState('app', 'practice1');
      expect(state).toEqual({});
    });

    test('setPracticeState and getPracticeState work together', async () => {
      await service.setPracticeState('app', 'practice1', { timezone: 'UTC' });
      const state = await service.getPracticeState('app', 'practice1');
      expect(state).toEqual({ timezone: 'UTC' });
    });

    test('bindSessionScope binds practice state', async () => {
      await service.setPracticeState('app', 'practice1', { tier: 'premium' });

      const session = (await service.createSession('app', {
        userId: 'user1',
      })) as BaseSession;
      service.bindSessionScope(session, 'practice', 'practice1');

      expect(session.practiceId).toBe('practice1');
      expect(session.state.practice.get('tier')).toBe('premium');
    });
  });

  describe('isolation between apps', () => {
    test('sessions are isolated by app name', async () => {
      await service.createSession('app1', {
        userId: 'user1',
        sessionId: 'session1',
      });
      await service.createSession('app2', {
        userId: 'user1',
        sessionId: 'session1',
      });

      const session1 = await service.getSession('app1', 'session1');
      const session2 = await service.getSession('app2', 'session1');

      expect(session1).not.toBe(session2);
    });

    test('user state is isolated by app name', async () => {
      await service.setUserState('app1', 'user1', { setting: 'app1-value' });
      await service.setUserState('app2', 'user1', { setting: 'app2-value' });

      expect(await service.getUserState('app1', 'user1')).toEqual({
        setting: 'app1-value',
      });
      expect(await service.getUserState('app2', 'user1')).toEqual({
        setting: 'app2-value',
      });
    });
  });
});
