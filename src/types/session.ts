import type { Event, ToolCallEvent } from './events';
import type { StateSchema, TypedState } from './schema';

export type SessionStatus = 'active' | 'awaiting_input' | 'completed' | 'error';

export interface Session<S extends StateSchema = StateSchema> {
  id: string;
  appName: string;
  readonly version?: string;
  userId?: string;
  patientId?: string;
  practiceId?: string;
  readonly events: readonly Event[];
  readonly state: TypedState<S>;
  readonly status: SessionStatus;
  readonly pendingYieldingCalls: ToolCallEvent[];
  readonly currentAgentName: string | undefined;
  addToolResult(callId: string, result: unknown): this;
  addMessage(text: string, invocationId?: string): this;
}

export interface SessionStoreSnapshot {
  sessionId: string;
  events: Event[];
  cursor?: number;
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionStoreSnapshot | null>;
  commit(snapshot: SessionStoreSnapshot): Promise<void>;
}

type ScopedStateGetter = (
  appName: string,
  id: string,
) => Promise<Record<string, unknown>>;

type ScopedStateSetter = (
  appName: string,
  id: string,
  state: Record<string, unknown>,
) => Promise<void>;

export interface CreateSessionOptions {
  sessionId?: string;
  userId?: string;
  patientId?: string;
  practiceId?: string;
  version?: string;
}

export interface SessionService {
  createSession(
    appName: string,
    options?: CreateSessionOptions,
  ): Promise<Session>;
  getSession(appName: string, sessionId: string): Promise<Session | null>;
  appendEvent(session: Session, event: Event): Promise<void>;
  deleteSession(appName: string, sessionId: string): Promise<void>;
  getUserState: ScopedStateGetter;
  setUserState: ScopedStateSetter;
  getPatientState: ScopedStateGetter;
  setPatientState: ScopedStateSetter;
  getPracticeState: ScopedStateGetter;
  setPracticeState: ScopedStateSetter;
}
