import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseSession } from './base';
import { LocalSessionService } from './local';

describe('LocalSessionService', () => {
  let dbPath: string;
  let service: LocalSessionService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `adk-test-${Date.now()}.db`);
    service = new LocalSessionService(dbPath);
  });

  afterEach(() => {
    service.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  test('creates database file', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  describe('SessionService interface', () => {
    test('createSession creates a new session', async () => {
      const session = await service.createSession('test-app', {
        sessionId: 'test-id',
        userId: 'user-1',
        patientId: 'patient-1',
      });

      expect(session.id).toBe('test-id');
      expect(session.appName).toBe('test-app');
      expect(session.userId).toBe('user-1');
      expect(session.patientId).toBe('patient-1');
    });

    test('createSession with initial state', async () => {
      const session = await service.createSession('test-app', {
        initialState: { key: 'value' },
      });

      expect(session.state.session.get('key')).toBe('value');
    });

    test('getSession loads existing session', async () => {
      await service.createSession('test-app', { sessionId: 'load-test' });
      const loaded = await service.getSession('test-app', 'load-test');

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('load-test');
    });

    test('getSession returns null for missing session', async () => {
      const loaded = await service.getSession('test-app', 'nonexistent');
      expect(loaded).toBeNull();
    });

    test('appendEvent adds event and persists', async () => {
      const session = await service.createSession('test-app', {
        sessionId: 'event-test',
      });

      await service.appendEvent(session, {
        id: 'evt-1',
        type: 'user',
        createdAt: Date.now(),
        text: 'Hello',
      });

      const loaded = await service.getSession('test-app', 'event-test');
      expect(loaded!.events).toHaveLength(1);
      expect(loaded!.events[0]).toMatchObject({ type: 'user', text: 'Hello' });
    });

    test('deleteSession removes session', async () => {
      await service.createSession('test-app', { sessionId: 'delete-test' });
      await service.deleteSession('test-app', 'delete-test');

      const loaded = await service.getSession('test-app', 'delete-test');
      expect(loaded).toBeNull();
    });
  });

  describe('shared state', () => {
    test('getUserState/setUserState', async () => {
      await service.setUserState('test-app', 'user-1', { pref: 'dark' });
      const state = await service.getUserState('test-app', 'user-1');

      expect(state).toEqual({ pref: 'dark' });
    });

    test('getPatientState/setPatientState', async () => {
      await service.setPatientState('test-app', 'patient-1', {
        condition: 'stable',
      });
      const state = await service.getPatientState('test-app', 'patient-1');

      expect(state).toEqual({ condition: 'stable' });
    });

    test('getPracticeState/setPracticeState', async () => {
      await service.setPracticeState('test-app', 'practice-1', {
        name: 'Test Practice',
      });
      const state = await service.getPracticeState('test-app', 'practice-1');

      expect(state).toEqual({ name: 'Test Practice' });
    });

    test('shared state persists through session mutations', async () => {
      const session = (await service.createSession('test-app', {
        sessionId: 'shared-test',
        userId: 'user-1',
      })) as BaseSession;

      const state = session.createBoundState('test-inv');
      state.user.set('theme', 'light');

      const loaded = await service.getSession('test-app', 'shared-test');
      expect(loaded!.state.user.get('theme')).toBe('light');

      const userState = await service.getUserState('test-app', 'user-1');
      expect(userState.theme).toBe('light');
    });

    test('bindSessionScope binds new scope to existing session', async () => {
      const session = (await service.createSession('test-app', {
        sessionId: 'bind-test',
      })) as BaseSession;

      await service.setPatientState('test-app', 'patient-new', {
        existing: 'data',
      });
      service.bindSessionScope(session, 'patient', 'patient-new');

      expect(session.patientId).toBe('patient-new');
      expect(session.state.patient.get('existing')).toBe('data');
    });
  });

  describe('convenience methods', () => {
    test('save persists session', () => {
      const session = new BaseSession('test-app', { id: 'save-test' });
      session.addMessage('Hello');

      service.save(session);

      const rows = service.list('test-app');
      expect(rows.find((r) => r.id === 'save-test')).toBeDefined();
    });

    test('list returns sessions ordered by updated_at', async () => {
      await service.createSession('test-app', { sessionId: 'first' });
      await new Promise((r) => setTimeout(r, 10));
      await service.createSession('test-app', { sessionId: 'second' });

      const list = service.list('test-app');

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('second');
      expect(list[1].id).toBe('first');
    });

    test('list filters by appName', async () => {
      await service.createSession('app-a', { sessionId: 'a1' });
      await service.createSession('app-b', { sessionId: 'b1' });

      expect(service.list('app-a')).toHaveLength(1);
      expect(service.list('app-b')).toHaveLength(1);
      expect(service.list('app-c')).toHaveLength(0);
    });
  });

  describe('state persistence', () => {
    test('session state survives save/load cycle', async () => {
      const session = await service.createSession('test-app', {
        sessionId: 'persist-test',
        userId: 'user-1',
        patientId: 'patient-1',
      });

      const state = session.createBoundState('test-inv');
      state.session.update({ counter: 42, nested: { a: 1 } });

      service.save(session as BaseSession);
      const loaded = await service.getSession('test-app', 'persist-test');

      expect(loaded!.state.session.get('counter')).toBe(42);
      expect(loaded!.state.session.get('nested')).toEqual({ a: 1 });
    });

    test('events persist correctly', async () => {
      const session = (await service.createSession('test-app', {
        sessionId: 'events-test',
      })) as BaseSession;

      session.addMessage('Message 1');
      service.save(session);

      session.addMessage('Message 2');
      service.save(session);

      const loaded = await service.getSession('test-app', 'events-test');
      const userEvents = loaded!.events.filter((e) => e.type === 'user');

      expect(userEvents).toHaveLength(2);
    });
  });
});
