import type { Session, Event, CreateSessionOptions } from '../types';
import { BaseSession, InMemorySessionService } from '../session';
import type { InitialState } from './types';

export class EvalSessionService extends InMemorySessionService {
  async createEvalSession(
    appName: string,
    initialState?: InitialState,
  ): Promise<Session> {
    const session = await this.createSession(appName, {
      initialState: initialState?.session,
    });

    const baseSession = session as BaseSession;

    if (initialState?.user) {
      baseSession.bindSharedState('user', { ...initialState.user });
    }
    if (initialState?.patient) {
      baseSession.bindSharedState('patient', { ...initialState.patient });
    }
    if (initialState?.practice) {
      baseSession.bindSharedState('practice', { ...initialState.practice });
    }

    return session;
  }

  async createUserAgentSession(appName: string): Promise<Session> {
    return this.createSession(appName, {});
  }
}

export function applyStateChanges(
  session: Session,
  changes: {
    session?: Record<string, unknown>;
    user?: Record<string, unknown>;
    patient?: Record<string, unknown>;
    practice?: Record<string, unknown>;
  },
  invocationId: string = 'eval-state-change',
): void {
  const state = session.createBoundState(invocationId);

  if (changes.session) {
    for (const [key, value] of Object.entries(changes.session)) {
      state.session.set(key, value);
    }
  }

  if (changes.user) {
    for (const [key, value] of Object.entries(changes.user)) {
      state.user.set(key, value);
    }
  }

  if (changes.patient) {
    for (const [key, value] of Object.entries(changes.patient)) {
      state.patient.set(key, value);
    }
  }

  if (changes.practice) {
    for (const [key, value] of Object.entries(changes.practice)) {
      state.practice.set(key, value);
    }
  }
}
