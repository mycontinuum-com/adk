import type { StateChanges } from '../session/seedState'
import type { SessionSnapshot } from '../session/snapshot'
import type { Event, ToolYieldEvent, MediaPart, SharedScope, StateChangeEvent } from './events'
import type { Output } from './runtime'
import type { StateSchema, TypedState } from './schema'

export type SessionStatus = 'active' | 'awaiting_input' | 'completed' | 'error'

export interface SpawnedTaskStatus {
  invocationId: string
  agentName: string
  startedAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'error'
  error?: string
}

export interface MessageInput {
  text?: string
  media?: MediaPart[]
  invocationId?: string
}

export interface ToolInput {
  callId: string
  input: unknown
}

export interface Input {
  message?: string | MessageInput
  tools?: ToolInput[]
  state?: Record<string, unknown>
  initialState?: StateChanges
}

export interface SessionInputNamespace<S extends StateSchema = StateSchema> {
  message(text: string): Session<S>
  message(options: MessageInput): Session<S>
  message(input: string | MessageInput): Session<S>
  tool(options: ToolInput): Session<S>
  tools(options: ToolInput[]): Session<S>
}

export interface Session<S extends StateSchema = StateSchema> {
  id: string
  appName: string
  readonly version?: number
  readonly scopes: Partial<Record<SharedScope, string>>
  readonly events: readonly Event[]
  readonly state: TypedState<S>
  readonly status: SessionStatus
  readonly yieldedTools: ToolYieldEvent[]
  readonly currentAgentName: string | undefined
  readonly input: SessionInputNamespace<S>
  readonly output: Output
  readonly createdAt: number

  boundState<T extends StateSchema = S>(invocationId: string): TypedState<T>
  clone(): Session<S>
  eventIndexOf(eventId: string): number | undefined
  stateAt(eventIndex: number): SessionSnapshot
  forkAt(eventIndex: number): Session
  onStateChange(callback: (event: StateChangeEvent) => void): this
  getSpawnedTaskStatus(invocationId: string): SpawnedTaskStatus | undefined
  getRunningSpawnedTasks(): SpawnedTaskStatus[]
  getAllSpawnedTasks(): SpawnedTaskStatus[]
  waitForSpawnedTask(invocationId: string): Promise<SpawnedTaskStatus | undefined>
  waitForAllSpawnedTasks(): Promise<SpawnedTaskStatus[]>
  hasRunningSpawnedTasks(): boolean
}

/**
 * Session metadata that crosses the SessionStore boundary. Events are excluded because sessions
 * routinely reach several MB of event data — DynamoDB's 400KB item limit becomes a hard ceiling,
 * and every commit would rewrite all events (write amplification).
 */
export interface StoredSession {
  id: string
  appName: string
  version: number
  scopes: Partial<Record<SharedScope, string>>
  createdAt: number
}

export type CommitResult =
  | { ok: true; version: number; merged?: boolean }
  | { ok: false; conflict: true; currentVersion: number }

export interface ScopedStateChange {
  scope: string
  scopeId: string
  changes: Record<string, unknown>
}

/**
 * Storage backend interface. Stores only handle persistence — all orchestration (scope binding,
 * event buffering, dirty tracking, cursor management) lives in the `sessionService()` factory. All
 * stores must pass `runSessionStoreTests()`.
 *
 * OCC over queues/locks: agent execution runs 5-60s — too long for distributed locks (crash = held
 * lease) and per-session queues serialize messages behind slow executions (unacceptable
 * conversational UX).
 */
export interface SessionStore {
  load(
    appName: string,
    sessionId: string,
  ): Promise<{ session: StoredSession; events: Event[] } | null>

  /**
   * OCC-guarded commit. On version mismatch return conflict result; on conflict, `scopedChanges`
   * must NOT be written. Transactional stores (SQLite, Postgres) apply scopedChanges atomically;
   * DynamoDB writes them after the OCC-guarded metadata put (best-effort). Pass 0 for first-create
   * semantics.
   */
  commit(
    session: StoredSession,
    newEvents: Event[],
    expectedVersion: number,
    scopedChanges?: ScopedStateChange[],
  ): Promise<CommitResult>

  delete(appName: string, sessionId: string): Promise<void>

  loadScopedState(appName: string, scope: string, scopeId: string): Promise<Record<string, unknown>>

  /** Merge-save: keys set to `undefined` are deleted, absent keys are untouched. */
  saveScopedState(
    appName: string,
    scope: string,
    scopeId: string,
    state: Record<string, unknown>,
  ): Promise<void>

  close(): Promise<void>

  list(appName: string): Promise<Array<{ id: string; updatedAt: number }>>
}

export interface CreateSessionOptions {
  sessionId?: string
  scopes?: Partial<Record<SharedScope, string>>
  version?: number
}

export interface SessionService {
  createSession(appName: string, options?: CreateSessionOptions): Promise<Session>
  getSession(appName: string, sessionId: string): Promise<Session | null>
  appendEvent(session: Session, event: Event): Promise<void>
  deleteSession(appName: string, sessionId: string): Promise<void>
  getScopedState(appName: string, scope: SharedScope, id: string): Promise<Record<string, unknown>>
  setScopedState(
    appName: string,
    scope: SharedScope,
    id: string,
    state: Record<string, unknown>,
  ): Promise<void>
  commitSession(session: Session, expectedVersion?: number): Promise<CommitResult>
  mergeSession(session: Session, latest?: Session): Promise<CommitResult>
  bindSessionScope?(session: Session, scope: string, id: string): Promise<void>
  listSessions(appName: string): Promise<Array<{ id: string; updatedAt: number }>>
}

/** App-bound session manager. Pre-binds appName and simplifies method names. */
export interface Sessions<S extends StateSchema = StateSchema> {
  create(options?: CreateSessionOptions): Promise<Session<S>>
  get(sessionId: string): Promise<Session<S> | null>
  delete(sessionId: string): Promise<void>
  list(): Promise<Array<{ id: string; updatedAt: number }>>
  commit(session: Session, expectedVersion?: number): Promise<CommitResult>
  merge(session: Session, latest?: Session): Promise<CommitResult>
}
