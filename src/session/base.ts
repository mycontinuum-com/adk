import { randomUUID } from 'node:crypto';
import { isEqual } from 'lodash';
import type {
  Session,
  SessionStatus,
  Event,
  UserEvent,
  StateChangeEvent,
  SessionState,
  StateAccessor,
  StateAccessorWithScopes,
  StateScope,
  ToolCallEvent,
  ToolYieldEvent,
  ToolInputEvent,
  ToolResultEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
} from '../types';
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

function createStateAccessor(
  getState: () => Record<string, unknown>,
  setState: (key: string, oldValue: unknown, newValue: unknown) => void,
  validateWrite?: () => void,
): StateAccessor {
  return {
    get<T = unknown>(key: string): T | undefined {
      return getState()[key] as T | undefined;
    },
    getMany<K extends string>(keys: K[]): Record<K, unknown> {
      const state = getState();
      return Object.fromEntries(keys.map((k) => [k, state[k]])) as Record<
        K,
        unknown
      >;
    },
    set(key: string, value: unknown): void {
      validateWrite?.();
      const current = getState();
      const oldValue = current[key];
      if (isEqual(oldValue, value)) return;
      setState(key, oldValue, value);
    },
    delete(key: string): void {
      validateWrite?.();
      const current = getState();
      const oldValue = current[key];
      if (oldValue === undefined) return;
      setState(key, oldValue, undefined);
    },
    update(changes: Record<string, unknown>): void {
      validateWrite?.();
      const current = getState();
      for (const [key, newValue] of Object.entries(changes)) {
        const oldValue = current[key];
        if (isEqual(oldValue, newValue)) continue;
        setState(key, oldValue, newValue);
      }
    },
    toObject(): Record<string, unknown> {
      return { ...getState() };
    },
  };
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

  setSessionState(key: string, value: unknown, invocationId: string): void {
    if (!invocationId) {
      throw new Error(
        'invocationId is required to set session state. Use session.createBoundState(invocationId) for state access.',
      );
    }

    const currentState = computeStateFromEvents(this._events, 'session');
    const oldValue = currentState[key];
    if (isEqual(oldValue, value)) return;

    const event: StateChangeEvent = {
      id: randomUUID(),
      type: 'state_change',
      scope: 'session',
      source: 'mutation',
      createdAt: Date.now(),
      invocationId,
      changes: [{ key, oldValue, newValue: value }],
    };
    this.appendEvent(event);
    this.stateChangeCallback?.(event);
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

  private createSharedAccessor(
    scope: 'user' | 'patient' | 'practice',
    invocationId?: string,
  ): StateAccessor {
    const binding = this.sharedStates.get(scope);
    if (!binding) {
      return createStateAccessor(
        () => ({}),
        () => {},
      );
    }

    const logStateChange = (
      source: 'observation' | 'mutation',
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

    const logObservation = (key: string, currentValue: unknown) => {
      if (!invocationId) return;
      const lastValue = this.getLastRecordedValue(scope, key);
      if (lastValue === currentValue) return;
      logStateChange('observation', key, lastValue, currentValue);
    };

    const logMutation = (key: string, oldValue: unknown, newValue: unknown) => {
      logStateChange('mutation', key, oldValue, newValue);
    };

    const requireInvocationId = () => {
      if (!invocationId) {
        throw new Error(
          `Cannot modify ${scope} state without invocationId. Use session.createBoundState(invocationId) instead.`,
        );
      }
    };

    return {
      get<T = unknown>(key: string): T | undefined {
        const value = binding.ref[key] as T | undefined;
        logObservation(key, value);
        return value;
      },
      getMany<K extends string>(keys: K[]): Record<K, unknown> {
        const result = {} as Record<K, unknown>;
        for (const key of keys) {
          const value = binding.ref[key];
          logObservation(key, value);
          result[key] = value;
        }
        return result;
      },
      set(key: string, value: unknown): void {
        requireInvocationId();
        const oldValue = binding.ref[key];
        if (isEqual(oldValue, value)) return;

        logMutation(key, oldValue, value);

        if (value === undefined) {
          delete binding.ref[key];
        } else {
          binding.ref[key] = value;
        }
        binding.onChange?.(key, value);
      },
      delete(key: string): void {
        requireInvocationId();
        const oldValue = binding.ref[key];
        if (oldValue === undefined) return;

        logMutation(key, oldValue, undefined);

        delete binding.ref[key];
        binding.onChange?.(key, undefined);
      },
      update(changes: Record<string, unknown>): void {
        requireInvocationId();
        for (const [key, newValue] of Object.entries(changes)) {
          const oldValue = binding.ref[key];
          if (isEqual(oldValue, newValue)) continue;

          logMutation(key, oldValue, newValue);

          if (newValue === undefined) {
            delete binding.ref[key];
          } else {
            binding.ref[key] = newValue;
          }
          binding.onChange?.(key, newValue);
        }
      },
      toObject(): Record<string, unknown> {
        return { ...binding.ref };
      },
    };
  }

  get state(): SessionState {
    const throwTempUnbound = (): Record<string, unknown> => {
      throw new Error(
        'Cannot access temp state without invocationId. Use session.createBoundState(invocationId) instead.',
      );
    };

    const throwSessionWriteUnbound = (): void => {
      throw new Error(
        'Cannot modify session state without invocationId. Use session.createBoundState(invocationId) instead.',
      );
    };

    return {
      session: createStateAccessor(
        () => computeStateFromEvents(this._events, 'session'),
        throwSessionWriteUnbound,
        throwSessionWriteUnbound,
      ),
      user: this.createSharedAccessor('user'),
      patient: this.createSharedAccessor('patient'),
      practice: this.createSharedAccessor('practice'),
      temp: createStateAccessor(throwTempUnbound, throwTempUnbound),
    };
  }

  createBoundState(invocationId: string): StateAccessorWithScopes {
    if (!invocationId) {
      throw new Error(
        'invocationId is required to create bound state accessor.',
      );
    }

    const sessionAccessor = createStateAccessor(
      () => computeStateFromEvents(this._events, 'session'),
      (key, oldValue, newValue) => {
        const event: StateChangeEvent = {
          id: randomUUID(),
          type: 'state_change',
          scope: 'session',
          source: 'mutation',
          createdAt: Date.now(),
          invocationId,
          changes: [{ key, oldValue, newValue }],
        };
        this.appendEvent(event);
        this.stateChangeCallback?.(event);
      },
    );

    const userAccessor = this.createSharedAccessor('user', invocationId);
    const patientAccessor = this.createSharedAccessor('patient', invocationId);
    const practiceAccessor = this.createSharedAccessor(
      'practice',
      invocationId,
    );
    const tempAccessor = createStateAccessor(
      () => this.getTempScopeForInvocation(invocationId),
      (key, _oldValue, newValue) => {
        const scope = this.getTempScopeForInvocation(invocationId);
        if (newValue === undefined) {
          delete scope[key];
        } else {
          scope[key] = newValue;
        }
      },
    );

    return {
      get: sessionAccessor.get.bind(sessionAccessor),
      getMany: sessionAccessor.getMany.bind(sessionAccessor),
      set: sessionAccessor.set.bind(sessionAccessor),
      delete: sessionAccessor.delete.bind(sessionAccessor),
      update: sessionAccessor.update.bind(sessionAccessor),
      toObject: sessionAccessor.toObject.bind(sessionAccessor),
      get session() {
        return sessionAccessor;
      },
      get user() {
        return userAccessor;
      },
      get patient() {
        return patientAccessor;
      },
      get practice() {
        return practiceAccessor;
      },
      get temp() {
        return tempAccessor;
      },
    };
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
      state: this.state.session.toObject(),
      userState: this.state.user.toObject(),
      patientState: this.state.patient.toObject(),
      practiceState: this.state.practice.toObject(),
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
