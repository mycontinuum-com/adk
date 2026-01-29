import type { Event, ToolCallEvent } from './events';

export type SessionStatus = 'active' | 'awaiting_input' | 'completed' | 'error';

export interface StateAccessor {
  get<T = unknown>(key: string): T | undefined;
  getMany<K extends string>(keys: K[]): Record<K, unknown>;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  update(changes: Record<string, unknown>): void;
  toObject(): Record<string, unknown>;
}

export interface StateAccessorWithScopes extends StateAccessor {
  readonly session: StateAccessor;
  readonly user: StateAccessor;
  readonly patient: StateAccessor;
  readonly practice: StateAccessor;
  readonly temp: StateAccessor;
}

export interface SessionState {
  session: StateAccessor;
  user: StateAccessor;
  patient: StateAccessor;
  practice: StateAccessor;
  temp: StateAccessor;
}

export interface Session {
  id: string;
  appName: string;
  readonly version?: string;
  userId?: string;
  patientId?: string;
  practiceId?: string;
  readonly events: readonly Event[];
  readonly state: SessionState;
  readonly status: SessionStatus;
  readonly pendingYieldingCalls: ToolCallEvent[];
  readonly currentAgentName: string | undefined;
  createBoundState(invocationId: string): StateAccessorWithScopes;
  addToolResult(callId: string, result: unknown): this;
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
  initialState?: Record<string, unknown>;
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
