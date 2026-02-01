import type {
  Session,
  SessionService,
  CreateSessionOptions,
  Event,
} from '../types';
import { BaseSession } from './base';

export class InMemorySessionService implements SessionService {
  private sessions = new Map<string, BaseSession>();
  private userStates = new Map<string, Record<string, unknown>>();
  private patientStates = new Map<string, Record<string, unknown>>();
  private practiceStates = new Map<string, Record<string, unknown>>();

  private sessionKey(appName: string, sessionId: string): string {
    return `${appName}#${sessionId}`;
  }

  private scopeKey(
    appName: string,
    scope: 'user' | 'patient' | 'practice',
    id: string,
  ): string {
    const prefix = scope === 'user' ? '' : `${scope}:`;
    return `${appName}:${prefix}${id}`;
  }

  private getStateMap(scope: 'user' | 'patient' | 'practice') {
    switch (scope) {
      case 'user':
        return this.userStates;
      case 'patient':
        return this.patientStates;
      case 'practice':
        return this.practiceStates;
    }
  }

  private bindScope(
    session: BaseSession,
    scope: 'user' | 'patient' | 'practice',
    id: string | undefined,
  ): void {
    if (!id) return;

    const stateMap = this.getStateMap(scope);
    const mapKey = this.scopeKey(session.appName, scope, id);
    let state = stateMap.get(mapKey);
    if (!state) {
      state = {};
      stateMap.set(mapKey, state);
    }
    session.bindSharedState(scope, state, (stateKey, value) => {
      const currentState = stateMap.get(mapKey) ?? {};
      if (value === undefined) {
        delete currentState[stateKey];
      } else {
        currentState[stateKey] = value;
      }
      stateMap.set(mapKey, currentState);
    });
  }

  async createSession(
    appName: string,
    options?: CreateSessionOptions,
  ): Promise<Session> {
    const { sessionId, userId, patientId, practiceId, version } = options ?? {};
    const session = new BaseSession(appName, {
      id: sessionId,
      userId,
      patientId,
      practiceId,
      version,
    });

    this.bindScope(session, 'user', userId);
    this.bindScope(session, 'patient', patientId);
    this.bindScope(session, 'practice', practiceId);

    this.sessions.set(this.sessionKey(appName, session.id), session);
    return session;
  }

  async getSession(
    appName: string,
    sessionId: string,
  ): Promise<Session | null> {
    const session = this.sessions.get(this.sessionKey(appName, sessionId));
    if (!session) return null;

    this.bindScope(session, 'user', session.userId);
    this.bindScope(session, 'patient', session.patientId);
    this.bindScope(session, 'practice', session.practiceId);

    return session;
  }

  async appendEvent(session: Session, event: Event): Promise<void> {
    (session as BaseSession).pushEvent(event);
  }

  async deleteSession(appName: string, sessionId: string): Promise<void> {
    this.sessions.delete(this.sessionKey(appName, sessionId));
  }

  private getScopedState(
    appName: string,
    scope: 'user' | 'patient' | 'practice',
    id: string,
  ): Record<string, unknown> {
    return {
      ...(this.getStateMap(scope).get(this.scopeKey(appName, scope, id)) ?? {}),
    };
  }

  private setScopedState(
    appName: string,
    scope: 'user' | 'patient' | 'practice',
    id: string,
    state: Record<string, unknown>,
  ): void {
    this.getStateMap(scope).set(this.scopeKey(appName, scope, id), {
      ...state,
    });
  }

  async getUserState(
    appName: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    return this.getScopedState(appName, 'user', userId);
  }

  async setUserState(
    appName: string,
    userId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    this.setScopedState(appName, 'user', userId, state);
  }

  async getPatientState(
    appName: string,
    patientId: string,
  ): Promise<Record<string, unknown>> {
    return this.getScopedState(appName, 'patient', patientId);
  }

  async setPatientState(
    appName: string,
    patientId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    this.setScopedState(appName, 'patient', patientId, state);
  }

  async getPracticeState(
    appName: string,
    practiceId: string,
  ): Promise<Record<string, unknown>> {
    return this.getScopedState(appName, 'practice', practiceId);
  }

  async setPracticeState(
    appName: string,
    practiceId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    this.setScopedState(appName, 'practice', practiceId, state);
  }

  bindSessionScope(
    session: BaseSession,
    scope: 'user' | 'patient' | 'practice',
    id: string,
  ): void {
    if (scope === 'user') {
      session.userId = id;
    } else if (scope === 'patient') {
      session.patientId = id;
    } else {
      session.practiceId = id;
    }
    this.bindScope(session, scope, id);
  }
}
