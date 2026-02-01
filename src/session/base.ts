import { randomUUID } from 'node:crypto';
import { isEqual } from 'lodash';
import type {
  Session,
  SessionStatus,
  Event,
  UserEvent,
  StateChangeEvent,
  StateChangeSource,
  StateScope,
  ToolCallEvent,
  ToolYieldEvent,
  ToolInputEvent,
  ToolResultEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
} from '../types';
import type { StateSchema, TypedState, ScopeState } from '../types/schema';
import {
  snapshotAt,
  findEventIndex,
  findInvocationBoundary,
  SnapshotError,
  type SessionSnapshot,
  type InvocationBoundary,
} from './snapshot';

function computeSessionStatus(events: Event[]): SessionStatus {
  const toolYields = events.filter(
    (e): e is ToolYieldEvent => e.type === 'tool_yield',
  );
  const hasUnresolvedToolYield = toolYields.some(
    (yieldEvent) =>
      !events.some(
        (e): e is ToolInputEvent =>
          e.type === 'tool_input' && e.callId === yieldEvent.callId,
      ),
  );
  if (hasUnresolvedToolYield) return 'awaiting_input';

  const inputYields = events.filter(
    (e): e is InvocationYieldEvent =>
      e.type === 'invocation_yield' && e.awaitingInput === true,
  );
  const hasUnresolvedInputYield = inputYields.some(
    (yieldEvent) =>
      !events.some(
        (e): e is InvocationResumeEvent =>
          e.type === 'invocation_resume' &&
          e.invocationId === yieldEvent.invocationId &&
          e.yieldIndex === yieldEvent.yieldIndex,
      ),
  );
  if (hasUnresolvedInputYield) return 'awaiting_input';

  const lastEnd = [...events]
    .reverse()
    .find((e): e is InvocationEndEvent => e.type === 'invocation_end');

  if (lastEnd?.reason === 'completed') return 'completed';
  if (lastEnd?.reason === 'error') return 'error';

  return 'active';
}

function computeStateFromEvents(
  events: Event[],
  scope: StateScope = 'session',
): Record<string, unknown> {
  return events.reduce<Record<string, unknown>>((acc, event) => {
    if (event.type === 'state_change' && event.scope === scope) {
      for (const change of event.changes) {
        if (change.newValue === undefined) {
          delete acc[change.key];
        } else {
          acc[change.key] = change.newValue;
        }
      }
    }
    return acc;
  }, {});
}

interface ScopeProxyConfig {
  scopeName: StateScope;
  getStorage: () => Record<string, unknown>;
  onChange: (key: string, oldValue: unknown, newValue: unknown) => void;
  onRead?: (key: string, value: unknown) => void;
}

function createScopeProxy<T extends Record<string, unknown>>(
  config: ScopeProxyConfig,
): T {
  const { scopeName, getStorage, onChange, onRead } = config;

  const updateFn = (changes: Record<string, unknown>) => {
    const storage = getStorage();
    for (const [key, newValue] of Object.entries(changes)) {
      const oldValue = storage[key];
      if (isEqual(oldValue, newValue)) continue;

      if (newValue === undefined) {
        delete storage[key];
      } else {
        storage[key] = newValue;
      }

      onChange(key, oldValue, newValue);
    }
  };

  return new Proxy({} as T, {
    get(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'update') return updateFn;
      const storage = getStorage();
      const value = storage[prop];
      onRead?.(prop, value);
      return value;
    },

    set(_target, prop: string | symbol, value: unknown) {
      if (typeof prop === 'symbol') return false;
      if (prop === 'update') return false;
      const storage = getStorage();
      const oldValue = storage[prop];
      if (isEqual(oldValue, value)) return true;

      if (value === undefined) {
        delete storage[prop];
      } else {
        storage[prop] = value;
      }

      onChange(prop, oldValue, value);
      return true;
    },

    deleteProperty(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return false;
      const storage = getStorage();
      const oldValue = storage[prop];
      if (oldValue === undefined) return true;
      delete storage[prop];
      onChange(String(prop), oldValue, undefined);
      return true;
    },

    has(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return false;
      if (prop === 'update') return true;
      const storage = getStorage();
      return prop in storage;
    },

    ownKeys() {
      const storage = getStorage();
      return Object.keys(storage);
    },

    getOwnPropertyDescriptor(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'update') {
        return {
          enumerable: false,
          configurable: true,
          value: updateFn,
          writable: false,
        };
      }
      const storage = getStorage();
      if (prop in storage) {
        return {
          enumerable: true,
          configurable: true,
          value: storage[prop],
          writable: true,
        };
      }
      return undefined;
    },
  });
}

interface SharedStateBinding {
  ref: Record<string, unknown>;
  onChange?: (key: string, value: unknown) => void;
}

export interface SpawnedTaskStatus {
  invocationId: string;
  agentName: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'error';
  error?: string;
}

interface SpawnedTask {
  promise: Promise<void>;
  status: SpawnedTaskStatus;
}

export interface BaseSessionOptions {
  id?: string;
  userId?: string;
  patientId?: string;
  practiceId?: string;
  version?: string;
  createdAt?: number;
}

export class BaseSession implements Session {
  id: string;
  appName: string;
  readonly version?: string;
  userId?: string;
  patientId?: string;
  practiceId?: string;
  readonly createdAt: number;
  private _events: Event[] = [];
  private stateChangeCallback?: (event: StateChangeEvent) => void;
  private sharedStates = new Map<string, SharedStateBinding>();
  private tempState = new Map<string, Record<string, unknown>>();
  private spawnedTasks = new Map<string, SpawnedTask>();

  constructor(appName: string, options?: BaseSessionOptions) {
    this.appName = appName;
    this.id = options?.id ?? randomUUID();
    this.userId = options?.userId;
    this.patientId = options?.patientId;
    this.practiceId = options?.practiceId;
    this.version = options?.version;
    this._events = [];
    this.createdAt = options?.createdAt ?? Date.now();
  }

  get events(): readonly Event[] {
    return this._events;
  }

  pushEvent(event: Event): void {
    this._events.push(event);
  }

  bindSharedState(
    scope: 'user' | 'patient' | 'practice',
    stateRef: Record<string, unknown>,
    onChange?: (key: string, value: unknown) => void,
  ): this {
    this.sharedStates.set(scope, { ref: stateRef, onChange });
    return this;
  }

  clearTempState(invocationId?: string): void {
    if (invocationId) {
      this.tempState.delete(invocationId);
    } else {
      this.tempState.clear();
    }
  }

  private getTempScopeForInvocation(
    invocationId: string,
  ): Record<string, unknown> {
    let scope = this.tempState.get(invocationId);
    if (!scope) {
      scope = {};
      this.tempState.set(invocationId, scope);
    }
    return scope;
  }

  inheritTempState(
    parentInvocationId: string,
    childInvocationId: string,
    overrides?: Record<string, unknown>,
  ): void {
    const parentScope = this.tempState.get(parentInvocationId) ?? {};
    const childScope = { ...parentScope, ...overrides };
    if (Object.keys(childScope).length > 0) {
      this.tempState.set(childInvocationId, childScope);
    }
  }

  trackSpawnedTask(
    invocationId: string,
    agentName: string,
    promise: Promise<void>,
  ): void {
    const status: SpawnedTaskStatus = {
      invocationId,
      agentName,
      startedAt: Date.now(),
      status: 'running',
    };

    const wrappedPromise = promise
      .then(() => {
        const task = this.spawnedTasks.get(invocationId);
        if (task) {
          Object.assign(task.status, {
            status: 'completed',
            completedAt: Date.now(),
          } satisfies Partial<SpawnedTaskStatus>);
        }
      })
      .catch((error) => {
        const task = this.spawnedTasks.get(invocationId);
        if (task) {
          Object.assign(task.status, {
            status: 'error',
            completedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          } satisfies Partial<SpawnedTaskStatus>);
        }
      });

    this.spawnedTasks.set(invocationId, { promise: wrappedPromise, status });
  }

  getSpawnedTaskStatus(invocationId: string): SpawnedTaskStatus | undefined {
    return this.spawnedTasks.get(invocationId)?.status;
  }

  getRunningSpawnedTasks(): SpawnedTaskStatus[] {
    return [...this.spawnedTasks.values()]
      .filter((t) => t.status.status === 'running')
      .map((t) => t.status);
  }

  getAllSpawnedTasks(): SpawnedTaskStatus[] {
    return [...this.spawnedTasks.values()].map((t) => t.status);
  }

  async waitForSpawnedTask(
    invocationId: string,
  ): Promise<SpawnedTaskStatus | undefined> {
    const task = this.spawnedTasks.get(invocationId);
    if (!task) return undefined;
    await task.promise;
    return task.status;
  }

  async waitForAllSpawnedTasks(): Promise<SpawnedTaskStatus[]> {
    const tasks = [...this.spawnedTasks.values()];
    await Promise.allSettled(tasks.map((t) => t.promise));
    return tasks.map((t) => t.status);
  }

  hasRunningSpawnedTasks(): boolean {
    return [...this.spawnedTasks.values()].some(
      (t) => t.status.status === 'running',
    );
  }

  private getLastRecordedValue(
    scope: StateScope,
    key: string,
  ): unknown | undefined {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];
      if (event.type === 'state_change' && event.scope === scope) {
        const change = event.changes.find((c) => c.key === key);
        if (change) {
          return change.newValue;
        }
      }
    }
    return undefined;
  }

  private createSharedScopeProxy<T extends Record<string, unknown>>(
    scope: 'user' | 'patient' | 'practice',
    invocationId?: string,
    writeSource: StateChangeSource = 'direct',
  ): T {
    const binding = this.sharedStates.get(scope);
    const emptyStorage: Record<string, unknown> = {};

    const logStateChange = (
      source: StateChangeSource,
      key: string,
      oldValue: unknown,
      newValue: unknown,
    ) => {
      const event: StateChangeEvent = {
        id: randomUUID(),
        type: 'state_change',
        scope,
        source,
        createdAt: Date.now(),
        invocationId,
        changes: [{ key, oldValue, newValue }],
      };
      this.appendEvent(event);
      this.stateChangeCallback?.(event);
    };

    return createScopeProxy<T>({
      scopeName: scope,
      getStorage: () => binding?.ref ?? emptyStorage,
      onChange: (key, oldValue, newValue) => {
        logStateChange(writeSource, key, oldValue, newValue);
        binding?.onChange?.(key, newValue);
      },
      onRead: invocationId
        ? (key, currentValue) => {
            const lastValue = this.getLastRecordedValue(scope, key);
            if (lastValue !== currentValue) {
              logStateChange('observation', key, lastValue, currentValue);
            }
          }
        : undefined,
    });
  }

  private _sessionStateCache: Record<string, unknown> | null = null;

  private getSessionState(): Record<string, unknown> {
    if (!this._sessionStateCache) {
      this._sessionStateCache = computeStateFromEvents(this._events, 'session');
    }
    return this._sessionStateCache;
  }

  private invalidateSessionStateCache(): void {
    this._sessionStateCache = null;
  }

  get state(): TypedState {
    return this.createTypedState();
  }

  private createTypedState<S extends StateSchema = StateSchema>(
    invocationId?: string,
    writeSource: StateChangeSource = 'direct',
  ): TypedState<S> {
    const sessionProxy = createScopeProxy<ScopeState<S['session']>>({
      scopeName: 'session',
      getStorage: () => this.getSessionState(),
      onChange: (key, oldValue, newValue) => {
        const storage = this.getSessionState();
        if (newValue === undefined) {
          delete storage[key];
        } else {
          storage[key] = newValue;
        }

        const event: StateChangeEvent = {
          id: randomUUID(),
          type: 'state_change',
          scope: 'session',
          source: writeSource,
          createdAt: Date.now(),
          invocationId,
          changes: [{ key, oldValue, newValue }],
        };
        this.appendEvent(event);
        this.stateChangeCallback?.(event);
      },
    });

    const userProxy = this.createSharedScopeProxy<ScopeState<S['user']>>(
      'user',
      invocationId,
      writeSource,
    );
    const patientProxy = this.createSharedScopeProxy<ScopeState<S['patient']>>(
      'patient',
      invocationId,
      writeSource,
    );
    const practiceProxy = this.createSharedScopeProxy<ScopeState<S['practice']>>(
      'practice',
      invocationId,
      writeSource,
    );

    const tempProxy = createScopeProxy<ScopeState<S['temp']>>({
      scopeName: 'temp',
      getStorage: () => {
        if (!invocationId) {
          throw new Error(
            'Temp state requires an invocation context. Use ctx.state.temp inside tools or hooks.',
          );
        }
        return this.getTempScopeForInvocation(invocationId);
      },
      onChange: () => {},
    });

    const scopes = {
      user: userProxy,
      patient: patientProxy,
      practice: practiceProxy,
      temp: tempProxy,
    };

    return new Proxy(scopes as TypedState<S>, {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in scopes) {
          return scopes[prop as keyof typeof scopes];
        }
        return sessionProxy[prop as keyof typeof sessionProxy];
      },
      set(_target, prop: string | symbol, value: unknown) {
        if (typeof prop === 'symbol') return false;
        if (prop in scopes) return false;
        (sessionProxy as Record<string, unknown>)[prop as string] = value;
        return true;
      },
      has(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return false;
        if (prop in scopes) return true;
        return prop in sessionProxy;
      },
      ownKeys() {
        return Object.keys(sessionProxy);
      },
      getOwnPropertyDescriptor(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in scopes) {
          return {
            enumerable: false,
            configurable: true,
            value: scopes[prop as keyof typeof scopes],
            writable: false,
          };
        }
        const value = sessionProxy[prop as keyof typeof sessionProxy];
        if (value !== undefined || prop in sessionProxy) {
          return {
            enumerable: true,
            configurable: true,
            value,
            writable: true,
          };
        }
        return undefined;
      },
    });
  }

  boundState<S extends StateSchema = StateSchema>(invocationId: string): TypedState<S> {
    if (!invocationId) {
      throw new Error('invocationId is required for bound state.');
    }
    return this.createTypedState<S>(invocationId, 'mutation');
  }

  onStateChange(callback: (event: StateChangeEvent) => void): this {
    this.stateChangeCallback = callback;
    return this;
  }

  private appendEvent(event: Event): void {
    this._events.push(event);
  }

  get status(): SessionStatus {
    return computeSessionStatus(this._events);
  }

  get pendingYieldingCalls(): ToolCallEvent[] {
    const toolYields = this._events.filter(
      (e): e is ToolYieldEvent => e.type === 'tool_yield',
    );
    const pendingYields = toolYields.filter(
      (yieldEvent) =>
        !this._events.some(
          (e): e is ToolInputEvent =>
            e.type === 'tool_input' && e.callId === yieldEvent.callId,
        ),
    );
    return pendingYields.map((yieldEvent) => {
      const toolCall = this._events.find(
        (e): e is ToolCallEvent =>
          e.type === 'tool_call' && e.callId === yieldEvent.callId,
      );
      return toolCall!;
    });
  }

  get currentAgentName(): string | undefined {
    const openInvocations = new Map<string, string>();

    for (const event of this._events) {
      if (event.type === 'invocation_start') {
        openInvocations.set(event.invocationId, event.agentName);
      } else if (event.type === 'invocation_end') {
        const e = event as InvocationEndEvent;
        openInvocations.delete(e.invocationId);
      }
    }

    const lastOpen = [...openInvocations.values()].pop();
    return lastOpen;
  }

  addToolResult(callId: string, result: unknown): this {
    const toolCall = this._events.find(
      (e): e is ToolCallEvent => e.type === 'tool_call' && e.callId === callId,
    );
    if (!toolCall) {
      throw new Error(`No tool_call found with callId: ${callId}`);
    }

    const existingResult = this._events.find(
      (e): e is ToolResultEvent =>
        e.type === 'tool_result' && e.callId === callId,
    );
    if (existingResult) {
      return this;
    }

    const resultEvent: ToolResultEvent = {
      id: randomUUID(),
      type: 'tool_result',
      createdAt: Date.now(),
      callId,
      name: toolCall.name,
      result,
      invocationId: toolCall.invocationId,
      agentName: toolCall.agentName,
      providerContext: toolCall.providerContext,
    };
    this.appendEvent(resultEvent);
    return this;
  }

  addToolInput(callId: string, input: unknown): this {
    const toolYield = this._events.find(
      (e): e is ToolYieldEvent =>
        e.type === 'tool_yield' && e.callId === callId,
    );
    if (!toolYield) {
      throw new Error(`No tool_yield found with callId: ${callId}`);
    }

    const existingInput = this._events.find(
      (e): e is ToolInputEvent =>
        e.type === 'tool_input' && e.callId === callId,
    );
    if (existingInput) {
      return this;
    }

    const inputEvent: ToolInputEvent = {
      id: randomUUID(),
      type: 'tool_input',
      createdAt: Date.now(),
      callId,
      name: toolYield.name,
      input,
      invocationId: toolYield.invocationId,
      agentName: toolYield.agentName,
    };
    this.appendEvent(inputEvent);
    return this;
  }

  addMessage(text: string, invocationId?: string): this {
    const message: UserEvent = {
      id: randomUUID(),
      type: 'user',
      createdAt: Date.now(),
      text,
      invocationId,
    };
    this.appendEvent(message);
    return this;
  }

  append(events: Event[]): this {
    for (const event of events) {
      this.appendEvent(event);
    }
    return this;
  }

  clone(): BaseSession {
    const cloned = new BaseSession(this.appName, {
      id: this.id,
      userId: this.userId,
      patientId: this.patientId,
      practiceId: this.practiceId,
      version: this.version,
    });
    cloned._events = structuredClone(this._events);
    cloned.stateChangeCallback = this.stateChangeCallback;
    for (const [scope, binding] of this.sharedStates) {
      cloned.sharedStates.set(scope, binding);
    }
    for (const [invocationId, state] of this.tempState) {
      cloned.tempState.set(invocationId, { ...state });
    }
    for (const [invocationId, task] of this.spawnedTasks) {
      cloned.spawnedTasks.set(invocationId, task);
    }
    return cloned;
  }

  stateAt(eventIndex: number): SessionSnapshot {
    return snapshotAt(this._events, eventIndex);
  }

  eventIndexOf(eventId: string): number | undefined {
    return findEventIndex(this._events, eventId);
  }

  invocationBoundary(invocationId: string): InvocationBoundary | undefined {
    return findInvocationBoundary(this._events, invocationId);
  }

  forkAt(eventIndex: number): BaseSession {
    if (eventIndex < 0 || eventIndex >= this._events.length) {
      throw new SnapshotError(
        `Event index ${eventIndex} out of bounds. Valid range: 0-${this._events.length - 1}`,
      );
    }

    const snapshot = snapshotAt(this._events, eventIndex);
    const eventsUpTo = structuredClone(this._events.slice(0, eventIndex + 1));

    const forked = new BaseSession(this.appName, {
      id: randomUUID(),
      userId: this.userId,
      patientId: this.patientId,
      practiceId: this.practiceId,
      version: this.version,
      createdAt: Date.now(),
    });

    forked._events = eventsUpTo;

    forked.bindSharedState('user', structuredClone(snapshot.userState));
    forked.bindSharedState('patient', structuredClone(snapshot.patientState));
    forked.bindSharedState('practice', structuredClone(snapshot.practiceState));

    return forked;
  }

  toJSON(): {
    id: string;
    appName: string;
    version?: string;
    userId?: string;
    patientId?: string;
    practiceId?: string;
    createdAt: number;
    events: Event[];
    state: Record<string, unknown>;
    userState: Record<string, unknown>;
    patientState: Record<string, unknown>;
    practiceState: Record<string, unknown>;
  } {
    return {
      id: this.id,
      appName: this.appName,
      version: this.version,
      userId: this.userId,
      patientId: this.patientId,
      practiceId: this.practiceId,
      createdAt: this.createdAt,
      events: [...this._events],
      state: { ...this.state },
      userState: { ...this.state.user },
      patientState: { ...this.state.patient },
      practiceState: { ...this.state.practice },
    };
  }

  static fromSnapshot(data: {
    id: string;
    appName: string;
    version?: string;
    userId?: string;
    patientId?: string;
    practiceId?: string;
    createdAt?: number;
    events: Event[];
    userState?: Record<string, unknown>;
    patientState?: Record<string, unknown>;
    practiceState?: Record<string, unknown>;
  }): BaseSession {
    const session = new BaseSession(data.appName, {
      id: data.id,
      createdAt: data.createdAt,
      userId: data.userId,
      patientId: data.patientId,
      practiceId: data.practiceId,
      version: data.version,
    });
    session._events = [...data.events];
    if (data.userState) {
      session.bindSharedState('user', data.userState);
    }
    if (data.patientState) {
      session.bindSharedState('patient', data.patientState);
    }
    if (data.practiceState) {
      session.bindSharedState('practice', data.practiceState);
    }
    return session;
  }
}
