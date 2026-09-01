import { isDeepStrictEqual } from 'node:util'

import type {
  Event,
  UserEvent,
  SharedScope,
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
  AssistantEvent,
} from '../types/events'
import type { Output } from '../types/runtime'
import type { StateSchema, TypedState, ScopeState } from '../types/schema'
import type {
  Session,
  SessionStatus,
  SessionInputNamespace,
  SpawnedTaskStatus,
  MessageInput,
  ToolInput,
} from '../types/session'

import { normalizeSessionId, createSessionId, createEventId } from '../core/constants'
import {
  snapshotAt,
  findEventIndex,
  findInvocationBoundary,
  SnapshotError,
  type SessionSnapshot,
  type InvocationBoundary,
} from './snapshot'

function computeSessionStatus(events: Event[]): SessionStatus {
  const toolYields = events.filter((e): e is ToolYieldEvent => e.type === 'tool_yield')
  const hasUnresolvedToolYield = toolYields.some(
    (yieldEvent) =>
      !events.some(
        (e): e is ToolInputEvent => e.type === 'tool_input' && e.callId === yieldEvent.callId,
      ),
  )
  if (hasUnresolvedToolYield) return 'awaiting_input'

  const inputYields = events.filter(
    (e): e is InvocationYieldEvent => e.type === 'invocation_yield' && e.awaitingInput === true,
  )
  const hasUnresolvedInputYield = inputYields.some(
    (yieldEvent) =>
      !events.some(
        (e): e is InvocationResumeEvent =>
          e.type === 'invocation_resume' &&
          e.invocationId === yieldEvent.invocationId &&
          e.yieldIndex === yieldEvent.yieldIndex,
      ),
  )
  if (hasUnresolvedInputYield) return 'awaiting_input'

  const lastEnd = [...events]
    .toReversed()
    .find((e): e is InvocationEndEvent => e.type === 'invocation_end')

  if (lastEnd?.reason === 'completed') return 'completed'
  if (lastEnd?.reason === 'error') return 'error'

  return 'active'
}

function computeStateFromEvents(
  events: Event[],
  scope: StateScope = 'session',
): Record<string, unknown> {
  return events.reduce<Record<string, unknown>>((acc, event) => {
    if (event.type === 'state_change' && event.scope === scope) {
      for (const change of event.changes) {
        if (change.newValue === undefined) {
          delete acc[change.key]
        } else {
          acc[change.key] = change.newValue
        }
      }
    }
    return acc
  }, {})
}

interface ScopeProxyConfig {
  scopeName: StateScope
  getStorage: () => Record<string, unknown>
  onChange: (key: string, oldValue: unknown, newValue: unknown) => void
  onRead?: (key: string, value: unknown) => void
}

function createScopeProxy<T extends Record<string, unknown>>(config: ScopeProxyConfig): T {
  const { scopeName: _scopeName, getStorage, onChange, onRead } = config

  const updateFn = (changes: Record<string, unknown>) => {
    const storage = getStorage()
    for (const [key, newValue] of Object.entries(changes)) {
      const oldValue = storage[key]
      if (isDeepStrictEqual(oldValue, newValue)) continue

      if (newValue === undefined) {
        delete storage[key]
      } else {
        storage[key] = newValue
      }

      onChange(key, oldValue, newValue)
    }
  }

  return new Proxy({} as T, {
    get(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'update') return updateFn
      const storage = getStorage()
      const value = storage[prop]
      onRead?.(prop, value)
      return value
    },

    set(_target, prop: string | symbol, value: unknown) {
      if (typeof prop === 'symbol') return false
      if (prop === 'update') return false
      const storage = getStorage()
      const oldValue = storage[prop]
      if (isDeepStrictEqual(oldValue, value)) return true

      if (value === undefined) {
        delete storage[prop]
      } else {
        storage[prop] = value
      }

      onChange(prop, oldValue, value)
      return true
    },

    deleteProperty(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return false
      const storage = getStorage()
      const oldValue = storage[prop]
      if (oldValue === undefined) return true
      delete storage[prop]
      onChange(String(prop), oldValue, undefined)
      return true
    },

    has(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return false
      if (prop === 'update') return true
      const storage = getStorage()
      return prop in storage
    },

    ownKeys() {
      const storage = getStorage()
      return Object.keys(storage)
    },

    getOwnPropertyDescriptor(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'update') {
        return {
          enumerable: false,
          configurable: true,
          value: updateFn,
          writable: false,
        }
      }
      const storage = getStorage()
      if (prop in storage) {
        return {
          enumerable: true,
          configurable: true,
          value: storage[prop],
          writable: true,
        }
      }
      return undefined
    },
  })
}

interface ConcurrentWriteTracker {
  writes: Map<string, { invocationId: string; timestamp: number }>
  warned: Set<string>
}

interface SharedStateBinding {
  ref: Record<string, unknown>
  onChange?: (key: string, value: unknown) => void
  concurrentTracker?: ConcurrentWriteTracker
}

interface SpawnedTask {
  promise: Promise<void>
  status: SpawnedTaskStatus
}

export interface BaseSessionOptions {
  id?: string
  scopes?: Partial<Record<SharedScope, string>>
  version?: number
  createdAt?: number
}

export class BaseSession<S extends StateSchema = StateSchema> implements Session<S> {
  id: string
  appName: string
  private _version?: number
  scopes: Partial<Record<SharedScope, string>>
  readonly createdAt: number
  private _events: Event[] = []
  private stateChangeCallback?: (event: StateChangeEvent) => void
  private sharedStates = new Map<string, SharedStateBinding>()
  private cachedState: TypedState<S> | null = null
  private tempState = new Map<string, Record<string, unknown>>()
  private spawnedTasks = new Map<string, SpawnedTask>()

  constructor(appName: string, options?: BaseSessionOptions) {
    this.appName = appName
    this.id = options?.id ? normalizeSessionId(options.id) : createSessionId()
    this.scopes = { ...options?.scopes }
    this._version = options?.version
    this._events = []
    this.createdAt = options?.createdAt ?? Date.now()
  }

  get version(): number | undefined {
    return this._version
  }

  setVersion(version: number): void {
    this._version = version
  }

  get events(): readonly Event[] {
    return this._events
  }

  pushEvent(event: Event): void {
    this._events.push(event)
  }

  tagTrailingEvents(invocationId: string): void {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const e = this._events[i]
      if (e.invocationId) break
      ;(e as { invocationId?: string }).invocationId = invocationId
    }
  }

  bindSharedState(
    scope: SharedScope,
    stateRef: Record<string, unknown>,
    onChange?: (key: string, value: unknown) => void,
  ): this {
    this.sharedStates.set(scope, {
      ref: stateRef,
      onChange,
      concurrentTracker: { writes: new Map(), warned: new Set() },
    })
    this.cachedState = null
    return this
  }

  clearTempState(invocationId?: string): void {
    if (invocationId) {
      this.tempState.delete(invocationId)
    } else {
      this.tempState.clear()
    }
  }

  private getTempScopeForInvocation(invocationId: string): Record<string, unknown> {
    let scope = this.tempState.get(invocationId)
    if (!scope) {
      scope = {}
      this.tempState.set(invocationId, scope)
    }
    return scope
  }

  inheritTempState(
    parentInvocationId: string,
    childInvocationId: string,
    overrides?: Record<string, unknown>,
  ): void {
    const parentScope = this.tempState.get(parentInvocationId) ?? {}
    const childScope = { ...parentScope, ...overrides }
    if (Object.keys(childScope).length > 0) {
      this.tempState.set(childInvocationId, childScope)
    }
  }

  trackSpawnedTask(invocationId: string, agentName: string, promise: Promise<void>): void {
    const status: SpawnedTaskStatus = {
      invocationId,
      agentName,
      startedAt: Date.now(),
      status: 'running',
    }

    const wrappedPromise = promise
      .then(() => {
        const task = this.spawnedTasks.get(invocationId)
        if (task) {
          Object.assign(task.status, {
            status: 'completed',
            completedAt: Date.now(),
          } satisfies Partial<SpawnedTaskStatus>)
        }
      })
      .catch((error) => {
        const task = this.spawnedTasks.get(invocationId)
        if (task) {
          Object.assign(task.status, {
            status: 'error',
            completedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          } satisfies Partial<SpawnedTaskStatus>)
        }
      })

    this.spawnedTasks.set(invocationId, { promise: wrappedPromise, status })
  }

  getSpawnedTaskStatus(invocationId: string): SpawnedTaskStatus | undefined {
    return this.spawnedTasks.get(invocationId)?.status
  }

  getRunningSpawnedTasks(): SpawnedTaskStatus[] {
    return [...this.spawnedTasks.values()]
      .filter((t) => t.status.status === 'running')
      .map((t) => t.status)
  }

  getAllSpawnedTasks(): SpawnedTaskStatus[] {
    return [...this.spawnedTasks.values()].map((t) => t.status)
  }

  async waitForSpawnedTask(invocationId: string): Promise<SpawnedTaskStatus | undefined> {
    const task = this.spawnedTasks.get(invocationId)
    if (!task) return undefined
    await task.promise
    return task.status
  }

  async waitForAllSpawnedTasks(): Promise<SpawnedTaskStatus[]> {
    const tasks = [...this.spawnedTasks.values()]
    await Promise.allSettled(tasks.map((t) => t.promise))
    return tasks.map((t) => t.status)
  }

  hasRunningSpawnedTasks(): boolean {
    return [...this.spawnedTasks.values()].some((t) => t.status.status === 'running')
  }

  private getLastRecordedValue(scope: StateScope, key: string): unknown | undefined {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i]
      if (event.type === 'state_change' && event.scope === scope) {
        const change = event.changes.find((c) => c.key === key)
        if (change) {
          return change.newValue
        }
      }
    }
    return undefined
  }

  private createSharedScopeProxy<T extends Record<string, unknown>>(
    scope: SharedScope,
    invocationId?: string,
    writeSource: StateChangeSource = 'direct',
  ): T {
    const getBinding = () => this.sharedStates.get(scope)
    const emptyStorage: Record<string, unknown> = {}

    const logStateChange = (
      source: StateChangeSource,
      key: string,
      oldValue: unknown,
      newValue: unknown,
    ) => {
      const event: StateChangeEvent = {
        id: createEventId(),
        type: 'state_change',
        scope,
        source,
        createdAt: Date.now(),
        invocationId,
        changes: [{ key, oldValue, newValue }],
      }
      this.appendEvent(event)
      this.stateChangeCallback?.(event)
    }

    const checkConcurrentWrite = (key: string) => {
      const binding = getBinding()
      if (!invocationId || !binding?.concurrentTracker) return
      const tracker = binding.concurrentTracker
      const trackerKey = `${scope}:${key}`
      const existing = tracker.writes.get(trackerKey)
      if (existing && existing.invocationId !== invocationId) {
        if (!tracker.warned.has(trackerKey)) {
          tracker.warned.add(trackerKey)
          console.warn(
            `[ADK] Concurrent write detected: '${scope}.${key}' written by multiple parallel branches. ` +
              `First write by invocation '${existing.invocationId.slice(0, 8)}...', ` +
              `conflicting write by '${invocationId.slice(0, 8)}...'. ` +
              `Consider using session-scoped state for branch-specific data.`,
          )
        }
      }
      tracker.writes.set(trackerKey, { invocationId, timestamp: Date.now() })
    }

    return createScopeProxy<T>({
      scopeName: scope,
      getStorage: () => getBinding()?.ref ?? emptyStorage,
      onChange: (key, oldValue, newValue) => {
        checkConcurrentWrite(key)
        logStateChange(writeSource, key, oldValue, newValue)
        getBinding()?.onChange?.(key, newValue)
      },
      onRead: invocationId
        ? (key, currentValue) => {
            const lastValue = this.getLastRecordedValue(scope, key)
            if (lastValue !== currentValue) {
              logStateChange('observation', key, lastValue, currentValue)
            }
          }
        : undefined,
    })
  }

  private getSessionState(): Record<string, unknown> {
    return computeStateFromEvents(this._events, 'session')
  }

  get state(): TypedState<S> {
    if (!this.cachedState) {
      this.cachedState = this.createTypedState()
    }
    return this.cachedState
  }

  private createTypedState(
    invocationId?: string,
    writeSource: StateChangeSource = 'direct',
  ): TypedState<S> {
    const sessionProxy = createScopeProxy<ScopeState<S['session']>>({
      scopeName: 'session',
      getStorage: () => this.getSessionState(),
      onChange: (key, oldValue, newValue) => {
        const event: StateChangeEvent = {
          id: createEventId(),
          type: 'state_change',
          scope: 'session',
          source: writeSource,
          createdAt: Date.now(),
          invocationId,
          changes: [{ key, oldValue, newValue }],
        }
        this.appendEvent(event)
        this.stateChangeCallback?.(event)
      },
    })

    const userProxy = this.createSharedScopeProxy<ScopeState<S['user']>>(
      'user',
      invocationId,
      writeSource,
    )
    const patientProxy = this.createSharedScopeProxy<ScopeState<S['patient']>>(
      'patient',
      invocationId,
      writeSource,
    )
    const practiceProxy = this.createSharedScopeProxy<ScopeState<S['practice']>>(
      'practice',
      invocationId,
      writeSource,
    )
    const orgProxy = this.createSharedScopeProxy<ScopeState<S['org']>>(
      'org',
      invocationId,
      writeSource,
    )
    const teamProxy = this.createSharedScopeProxy<ScopeState<S['team']>>(
      'team',
      invocationId,
      writeSource,
    )

    const tempProxy = createScopeProxy<ScopeState<S['temp']>>({
      scopeName: 'temp',
      getStorage: () => {
        if (!invocationId) {
          throw new Error(
            'Temp state requires an invocation context. Use ctx.state.temp inside tools or hooks.',
          )
        }
        return this.getTempScopeForInvocation(invocationId)
      },
      onChange: () => {},
    })

    const scopeProxies = {
      user: userProxy,
      patient: patientProxy,
      practice: practiceProxy,
      org: orgProxy,
      team: teamProxy,
      temp: tempProxy,
    }

    return new Proxy(scopeProxies as unknown as TypedState<S>, {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined
        if (prop in scopeProxies) {
          return scopeProxies[prop as keyof typeof scopeProxies]
        }
        return sessionProxy[prop as keyof typeof sessionProxy]
      },
      set(_target, prop: string | symbol, value: unknown) {
        if (typeof prop === 'symbol') return false
        if (prop in scopeProxies) return false
        ;(sessionProxy as Record<string, unknown>)[prop as string] = value
        return true
      },
      has(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return false
        if (prop in scopeProxies) return true
        return prop in sessionProxy
      },
      ownKeys() {
        return Object.keys(sessionProxy)
      },
      getOwnPropertyDescriptor(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined
        if (prop in scopeProxies) {
          return {
            enumerable: false,
            configurable: true,
            value: scopeProxies[prop as keyof typeof scopeProxies],
            writable: false,
          }
        }
        const value = sessionProxy[prop as keyof typeof sessionProxy]
        if (value !== undefined || prop in sessionProxy) {
          return {
            enumerable: true,
            configurable: true,
            value,
            writable: true,
          }
        }
        return undefined
      },
    })
  }

  boundState<T extends StateSchema = S>(invocationId: string): TypedState<T> {
    if (!invocationId) {
      throw new Error('invocationId is required for bound state.')
    }
    return this.createTypedState(invocationId, 'mutation') as unknown as TypedState<T>
  }

  onStateChange(callback: (event: StateChangeEvent) => void): this {
    this.stateChangeCallback = callback
    return this
  }

  private appendEvent(event: Event): void {
    this._events.push(event)
  }

  get status(): SessionStatus {
    return computeSessionStatus(this._events)
  }

  get yieldedTools(): ToolYieldEvent[] {
    const toolYields = this._events.filter((e): e is ToolYieldEvent => e.type === 'tool_yield')
    return toolYields.filter(
      (yieldEvent) =>
        !this._events.some(
          (e): e is ToolInputEvent => e.type === 'tool_input' && e.callId === yieldEvent.callId,
        ),
    )
  }

  get input(): SessionInputNamespace<S> {
    // oxlint-disable-next-line typescript-eslint(no-this-alias)
    const self = this
    return {
      message(textOrOptions: string | MessageInput): Session<S> {
        if (typeof textOrOptions === 'string') {
          return self.addUserMessage({ text: textOrOptions })
        }
        return self.addUserMessage(textOrOptions)
      },
      tool(options: ToolInput): Session<S> {
        const hasYield = self._events.some(
          (e): e is ToolYieldEvent => e.type === 'tool_yield' && e.callId === options.callId,
        )
        if (hasYield) {
          return self.addToolInput(options.callId, options.input)
        }
        return self.addToolResult(options.callId, options.input)
      },
      tools(options: ToolInput[]): Session<S> {
        for (const opt of options) {
          this.tool(opt)
        }
        return self
      },
    }
  }

  get output(): Output {
    const assistantEvents = this._events.filter((e): e is AssistantEvent => e.type === 'assistant')
    const lastAssistant = assistantEvents[assistantEvents.length - 1]
    const allMedia = assistantEvents.flatMap((e) => e.media ?? [])

    return {
      get text() {
        return lastAssistant?.text
      },
      get value() {
        return lastAssistant?.output?.value
      },
      get items() {
        return assistantEvents
      },
      get media() {
        return allMedia.length > 0 ? allMedia : undefined
      },
    }
  }

  get currentAgentName(): string | undefined {
    const openInvocations = new Map<string, string>()

    for (const event of this._events) {
      if (event.type === 'invocation_start') {
        openInvocations.set(event.invocationId, event.agentName)
      } else if (event.type === 'invocation_end') {
        openInvocations.delete(event.invocationId)
      }
    }

    const lastOpen = [...openInvocations.values()].pop()
    return lastOpen
  }

  private addToolResult(callId: string, result: unknown): this {
    const toolCall = this._events.find(
      (e): e is ToolCallEvent => e.type === 'tool_call' && e.callId === callId,
    )
    if (!toolCall) {
      throw new Error(`No tool_call found with callId: ${callId}`)
    }

    const existingResult = this._events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result' && e.callId === callId,
    )
    if (existingResult) {
      return this
    }

    const resultEvent: ToolResultEvent = {
      id: createEventId(),
      type: 'tool_result',
      createdAt: Date.now(),
      callId,
      name: toolCall.name,
      result,
      invocationId: toolCall.invocationId,
      agentName: toolCall.agentName,
      providerContext: toolCall.providerContext,
    }
    this.appendEvent(resultEvent)
    return this
  }

  private addToolInput(callId: string, input: unknown): this {
    const toolYield = this._events.find(
      (e): e is ToolYieldEvent => e.type === 'tool_yield' && e.callId === callId,
    )
    if (!toolYield) {
      throw new Error(`No tool_yield found with callId: ${callId}`)
    }

    const existingInput = this._events.find(
      (e): e is ToolInputEvent => e.type === 'tool_input' && e.callId === callId,
    )
    if (existingInput) {
      return this
    }

    const inputEvent: ToolInputEvent = {
      id: createEventId(),
      type: 'tool_input',
      createdAt: Date.now(),
      callId,
      name: toolYield.name,
      input,
      invocationId: toolYield.invocationId,
      agentName: toolYield.agentName,
    }
    this.appendEvent(inputEvent)
    return this
  }

  private addUserMessage(options: MessageInput): this {
    const message: UserEvent = {
      id: createEventId(),
      type: 'user',
      createdAt: Date.now(),
      text: options.text ?? '',
      media: options.media?.length ? options.media : undefined,
      invocationId: options.invocationId,
    }
    this.appendEvent(message)
    return this
  }

  clone(): BaseSession<S> {
    const cloned = new BaseSession<S>(this.appName, {
      id: this.id,
      scopes: { ...this.scopes },
      version: this.version,
    })
    cloned._events = structuredClone(this._events)
    cloned.stateChangeCallback = this.stateChangeCallback
    for (const [scope, binding] of this.sharedStates) {
      cloned.sharedStates.set(scope, binding)
    }
    for (const [invocationId, state] of this.tempState) {
      cloned.tempState.set(invocationId, { ...state })
    }
    for (const [invocationId, task] of this.spawnedTasks) {
      cloned.spawnedTasks.set(invocationId, task)
    }
    return cloned
  }

  stateAt(eventIndex: number): SessionSnapshot {
    return snapshotAt(this._events, eventIndex)
  }

  eventIndexOf(eventId: string): number | undefined {
    return findEventIndex(this._events, eventId)
  }

  invocationBoundary(invocationId: string): InvocationBoundary | undefined {
    return findInvocationBoundary(this._events, invocationId)
  }

  forkAt(eventIndex: number): BaseSession {
    if (eventIndex < 0 || eventIndex >= this._events.length) {
      throw new SnapshotError(
        `Event index ${eventIndex} out of bounds. Valid range: 0-${this._events.length - 1}`,
      )
    }

    const snapshot = snapshotAt(this._events, eventIndex)
    const eventsUpTo = structuredClone(this._events.slice(0, eventIndex + 1))

    const forked = new BaseSession(this.appName, {
      id: createSessionId(),
      scopes: { ...this.scopes },
      version: this.version,
      createdAt: Date.now(),
    })

    forked._events = eventsUpTo

    for (const [scope, state] of Object.entries(snapshot.scopedStates)) {
      forked.bindSharedState(scope as SharedScope, structuredClone(state))
    }

    return forked
  }

  toJSON(): {
    id: string
    appName: string
    version?: number
    scopes: Partial<Record<SharedScope, string>>
    createdAt: number
    events: Event[]
    state: Record<string, unknown>
    scopedStates: Partial<Record<SharedScope, Record<string, unknown>>>
  } {
    const scopedStates: Partial<Record<SharedScope, Record<string, unknown>>> = {}
    for (const [scope, binding] of this.sharedStates) {
      scopedStates[scope as SharedScope] = { ...binding.ref }
    }
    return {
      id: this.id,
      appName: this.appName,
      version: this.version,
      scopes: { ...this.scopes },
      createdAt: this.createdAt,
      events: [...this._events],
      state: { ...this.state },
      scopedStates,
    }
  }

  static fromSnapshot(data: {
    id: string
    appName: string
    version?: number
    scopes?: Partial<Record<SharedScope, string>>
    createdAt?: number
    events: Event[]
    scopedStates?: Partial<Record<SharedScope, Record<string, unknown>>>
  }): BaseSession {
    const session = new BaseSession(data.appName, {
      id: data.id,
      createdAt: data.createdAt,
      scopes: data.scopes,
      version: data.version,
    })
    session._events = [...data.events]
    if (data.scopedStates) {
      for (const [scope, state] of Object.entries(data.scopedStates)) {
        if (state) {
          session.bindSharedState(scope as SharedScope, state)
        }
      }
    }
    return session
  }
}
