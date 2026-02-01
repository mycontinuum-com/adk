import type { Session } from '../types';
import type { StateChanges } from './types';
import { BaseSession, InMemorySessionService } from '../session';

export class EvalSessionService extends InMemorySessionService {
  async createEvalSession(
    appName: string,
    initialState?: StateChanges,
  ): Promise<Session> {
    const session = await this.createSession(appName);
    if (initialState) {
      if (initialState.session) {
        session.state.update(initialState.session);
      }
      if (initialState.user) {
        (session as BaseSession).bindSharedState('user', { ...initialState.user });
      }
      if (initialState.patient) {
        (session as BaseSession).bindSharedState('patient', { ...initialState.patient });
      }
      if (initialState.practice) {
        (session as BaseSession).bindSharedState('practice', { ...initialState.practice });
      }
    }
    return session;
  }

  async createUserAgentSession(appName: string): Promise<Session> {
    return this.createSession(appName);
  }
}
