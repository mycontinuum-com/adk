/**
 * Gateway — Process lifecycle management and event routing.
 *
 * The gateway is the central coordination point for the process runtime: - Manages process
 * lifecycle (dispatch → sleep → wake → execute → complete) - Routes events to subscribers (live
 * during execution, historical from store) - Coordinates with executors for turn execution -
 * Implements poll-based scheduling with claimDue/revertStale
 */

import { randomUUID } from 'node:crypto'

import type { CodingAgent } from '../agents/coding/types'
import type { ArtifactService } from '../artifacts/types'
import type { StreamEvent, Event } from '../types/events'
import type { Agent } from '../types/runnables'
import type { SessionService } from '../types/session'
import type {
  Gateway,
  GatewayConfig,
  DispatchOptions,
  SendOptions,
  SubscribeOptions,
  ProcessEvent,
  ProcessStatusResponse,
  Executor,
  ExecutionRequest,
  ExecutionResult,
} from './gateway-types'
import type { ProcessStore, StoredProcess, ProcessStatus } from './types'

import { sessionService as createSessionService } from '../session/service'
import { isUserEvent } from '../types/events'

/** Generate a unique ID with prefix. */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

interface ProcessSubscription {
  subscribers: Set<(event: ProcessEvent) => void>
  abortController?: AbortController
  emittedEvents: ProcessEvent[]
}

/** Gateway implementation. */
export class GatewayImpl implements Gateway {
  private readonly appName: string
  private readonly processStore: ProcessStore
  private readonly sessionService: SessionService
  private readonly artifactService?: ArtifactService
  private readonly defaultExecutor: Executor
  private readonly executors: Map<string, Executor>
  private readonly agents: Map<string, Agent | CodingAgent>
  private readonly staleTimeoutMs: number

  private readonly subscriptions = new Map<string, ProcessSubscription>()
  private readonly activeExecutions = new Map<string, Promise<void>>()

  private pollInterval: ReturnType<typeof setInterval> | null = null
  private isShuttingDown = false

  constructor(config: GatewayConfig) {
    this.appName = config.appName
    this.processStore = config.processStore
    this.sessionService = createSessionService(config.sessionStore)
    this.artifactService = config.artifactService
    this.defaultExecutor = config.defaultExecutor
    this.staleTimeoutMs = config.staleTimeoutMs ?? 60_000

    this.executors = new Map()
    this.executors.set(config.defaultExecutor.name, config.defaultExecutor)
    if (config.executors) {
      for (const [name, executor] of Object.entries(config.executors)) {
        this.executors.set(name, executor)
      }
    }

    if (config.agents instanceof Map) {
      this.agents = config.agents
    } else {
      this.agents = new Map(Object.entries(config.agents))
    }
  }

  async dispatch(agentName: string, options?: DispatchOptions): Promise<string> {
    const agent = this.agents.get(agentName)
    if (!agent) {
      throw new Error(`Agent '${agentName}' not found in registry`)
    }

    const processId = generateId('proc')
    const sessionId = options?.sessionId ?? generateId('sess')
    const executorName = options?.executor ?? this.defaultExecutor.name

    // Create session
    const session = await this.sessionService.createSession(this.appName, {
      sessionId,
    })

    // If there's input, add it as a user event
    if (options?.input !== undefined) {
      const userEvent: Event = {
        type: 'user',
        id: generateId('evt'),
        createdAt: Date.now(),
        text: typeof options.input === 'string' ? options.input : JSON.stringify(options.input),
      }
      await this.sessionService.appendEvent(session, userEvent)
      await this.sessionService.commitSession(session)
    }

    // Create process record with immediate wake
    const process: StoredProcess = {
      id: processId,
      appName: this.appName,
      agentName,
      sessionId,
      status: 'sleeping',
      paused: false,
      schedule: null,
      nextWakeAt: new Date(), // Wake immediately
      executor: executorName,
      executorConfig: options?.executorConfig ?? {},
      lastRunAt: null,
      createdAt: new Date(),
      metadata: options?.metadata ?? {},
    }

    await this.processStore.create(process)

    return processId
  }

  async send(processId: string, payload: unknown, options?: SendOptions): Promise<void> {
    const process = await this.processStore.get(this.appName, processId)
    if (!process) {
      throw new Error(`Process '${processId}' not found`)
    }

    if (process.status === 'completed') {
      await this.processStore.update(this.appName, processId, { status: 'sleeping' })
      this.emitProcessEvent(processId, {
        type: 'status_change',
        status: 'sleeping',
        previousStatus: 'completed',
      })
    }

    await this.processStore.enqueueMessage(this.appName, processId, {
      id: generateId('msg'),
      payload,
      authorId: options?.author?.id ?? null,
      authorName: options?.author?.name ?? null,
      createdAt: new Date(),
    })
  }

  async *subscribe(processId: string, options?: SubscribeOptions): AsyncGenerator<ProcessEvent> {
    const process = await this.processStore.get(this.appName, processId)
    if (!process) {
      throw new Error(`Process '${processId}' not found`)
    }

    const subscription = this.getOrCreateSubscription(processId)

    // Register the live subscriber BEFORE reading historical events so that
    // any events emitted between the historical read and the live loop are
    // captured in the queue instead of being lost.
    const eventQueue: ProcessEvent[] = []
    let resolveNext: ((value: IteratorResult<ProcessEvent>) => void) | null = null
    let done = false

    const onEvent = (event: ProcessEvent) => {
      if (done) return

      if (event.type === 'completed') {
        done = true
      }

      if (resolveNext) {
        resolveNext({ value: event, done: false })
        resolveNext = null
      } else {
        eventQueue.push(event)
      }
    }

    subscription.subscribers.add(onEvent)

    try {
      const yieldedIds = new Set<string>()

      const session = await this.sessionService.getSession(this.appName, process.sessionId)
      if (session) {
        const cursor = options?.after
        let pastCursor = !cursor
        for (const event of session.events) {
          if (event.id) yieldedIds.add(event.id)
          if (pastCursor) {
            yield { type: 'stream', event: event as StreamEvent }
          } else if (event.id === cursor) {
            pastCursor = true
          }
        }
      }

      const bufferedSnapshot = subscription.emittedEvents.slice()
      for (const buffered of bufferedSnapshot) {
        if (buffered.type === 'stream' && buffered.event.id && yieldedIds.has(buffered.event.id)) {
          continue
        }
        if (buffered.type === 'stream' && buffered.event.id) {
          yieldedIds.add(buffered.event.id)
        }
        yield buffered
        if (buffered.type === 'completed') return
      }

      const currentProcess = await this.processStore.get(this.appName, processId)
      if (currentProcess?.status === 'completed' && eventQueue.length === 0) {
        yield { type: 'completed', finalStatus: 'completed' }
        return
      }

      // oxlint-disable-next-line eslint(no-unmodified-loop-condition)
      while (!done) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!

          // Deduplicate: skip stream events already yielded from history
          if (event.type === 'stream' && event.event.id && yieldedIds.has(event.event.id)) {
            continue
          }

          if (event.type === 'completed') {
            yield event
            return
          }
          yield event
        } else {
          // Wait for next event
          const event = await new Promise<ProcessEvent>((resolve) => {
            resolveNext = (result) => resolve(result.value)
          })

          if (event.type === 'stream' && event.event.id && yieldedIds.has(event.event.id)) {
            continue
          }

          if (event.type === 'completed') {
            yield event
            return
          }
          yield event
        }
      }
    } finally {
      subscription.subscribers.delete(onEvent)
      if (subscription.subscribers.size === 0 && !this.activeExecutions.has(processId)) {
        this.subscriptions.delete(processId)
      }
    }
  }

  async status(processId: string): Promise<ProcessStatusResponse | null> {
    const process = await this.processStore.get(this.appName, processId)
    if (!process) {
      return null
    }

    const response: ProcessStatusResponse = {
      id: process.id,
      agentName: process.agentName,
      sessionId: process.sessionId,
      status: process.status,
      paused: process.paused,
      createdAt: process.createdAt,
      lastRunAt: process.lastRunAt,
      nextWakeAt: process.nextWakeAt,
      executor: process.executor,
      executorConfig: process.executorConfig,
      metadata: process.metadata,
    }

    // Include artifacts if service is configured
    if (this.artifactService) {
      const artifacts = await this.artifactService.list(this.appName, processId)
      response.artifacts = artifacts.map((a) => ({
        name: a.name,
        version: a.latestVersion,
        mimeType: a.mimeType,
      }))
    }

    return response
  }

  async stop(processId: string): Promise<void> {
    const process = await this.processStore.get(this.appName, processId)
    if (!process) {
      throw new Error(`Process '${processId}' not found`)
    }

    if (process.status === 'completed') {
      return // Already stopped
    }

    const previousStatus = process.status

    // If running, signal abort
    const subscription = this.subscriptions.get(processId)
    if (subscription?.abortController) {
      subscription.abortController.abort()
    }

    // Update status
    await this.processStore.update(this.appName, processId, {
      status: 'completed',
      nextWakeAt: null,
    })

    this.emitCompletion(processId, previousStatus)

    // Clean up executor resources
    const executor = this.getExecutor(process.executor)
    await executor.cleanup?.(processId)
  }

  start(options?: { intervalMs?: number }): void {
    if (this.pollInterval) {
      return // Already running
    }

    const intervalMs = options?.intervalMs ?? 1000
    this.isShuttingDown = false

    this.pollInterval = setInterval(() => {
      this.pollTick().catch((err) => {
        console.error('Gateway poll error:', err)
      })
    }, intervalMs)

    // Run immediately
    this.pollTick().catch((err) => {
      console.error('Gateway poll error:', err)
    })
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true

    // Stop poll loop
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    // Abort all active executions
    for (const subscription of this.subscriptions.values()) {
      subscription.abortController?.abort()
    }

    // Wait for active executions to complete
    if (this.activeExecutions.size > 0) {
      await Promise.all(this.activeExecutions.values())
    }
  }

  private async pollTick(): Promise<void> {
    if (this.isShuttingDown) return

    // Revert stale processes first
    await this.processStore.revertStale(this.appName, this.staleTimeoutMs)

    // Claim due processes
    const claimed = await this.processStore.claimDue(this.appName, 10)

    // Execute each claimed process
    for (const process of claimed) {
      if (this.isShuttingDown) break

      // Don't start if already executing
      if (this.activeExecutions.has(process.id)) continue

      const execution = this.executeProcess(process)
      this.activeExecutions.set(process.id, execution)

      execution.finally(() => {
        this.activeExecutions.delete(process.id)
        const sub = this.subscriptions.get(process.id)
        if (sub && sub.subscribers.size === 0) {
          this.subscriptions.delete(process.id)
        }
      })
    }
  }

  private async executeProcess(process: StoredProcess): Promise<void> {
    const agent = this.agents.get(process.agentName)
    if (!agent) {
      await this.completeWithError(process.id, `Agent '${process.agentName}' not found`)
      return
    }

    const executor = this.getExecutor(process.executor)

    // Get or create session
    let session = await this.sessionService.getSession(this.appName, process.sessionId)
    if (!session) {
      await this.completeWithError(process.id, `Session '${process.sessionId}' not found`)
      return
    }

    // Consume pending messages
    const messages = await this.processStore.consumeMessages(this.appName, process.id)

    // Create abort controller
    const abortController = new AbortController()

    const subscription = this.getOrCreateSubscription(process.id)
    subscription.abortController = abortController
    subscription.emittedEvents = []

    const previousStatus = process.status
    await this.processStore.update(this.appName, process.id, {
      status: 'running',
      lastRunAt: new Date(),
    })

    this.emitProcessEvent(process.id, {
      type: 'status_change',
      status: 'running',
      previousStatus,
    })

    try {
      let result: ExecutionResult

      if (this.isCodingAgent(agent)) {
        result = await this.executeCodingAgent(agent, session, messages, abortController, (event) =>
          this.emitProcessEvent(process.id, { type: 'stream', event }),
        )
      } else {
        const request: ExecutionRequest = {
          process: { ...process, status: 'running' },
          session,
          agent,
          messages: messages.map((m) => ({
            payload: m.payload,
            authorId: m.authorId ?? undefined,
            authorName: m.authorName ?? undefined,
          })),
          signal: abortController.signal,
        }

        result = await executor.execute(request, (event) => {
          this.emitProcessEvent(process.id, { type: 'stream', event })
        })
      }

      if (result.status === 'errored') {
        await this.completeWithError(process.id, result.error ?? 'Unknown error')
      } else {
        const processUpdate: import('./types').ProcessUpdate = {
          status: result.status,
          nextWakeAt: result.nextWakeAt ?? null,
        }
        if (result.executorConfig) {
          processUpdate.executorConfig = result.executorConfig
        }
        await this.processStore.update(this.appName, process.id, processUpdate)

        if (result.status === 'completed') {
          this.emitCompletion(process.id, 'running')
          await executor.cleanup?.(process.id)
        } else {
          this.emitProcessEvent(process.id, {
            type: 'status_change',
            status: result.status,
            previousStatus: 'running',
          })
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await this.completeWithError(process.id, errorMsg)
    } finally {
      if (subscription.abortController === abortController) {
        subscription.abortController = undefined
      }
    }
  }

  private isCodingAgent(agent: Agent | CodingAgent): agent is CodingAgent {
    return typeof (agent as CodingAgent).run === 'function' && !('kind' in agent)
  }

  private async executeCodingAgent(
    agent: CodingAgent,
    session: Awaited<ReturnType<SessionService['getSession']>> & {},
    _messages: unknown[],
    abortController: AbortController,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ExecutionResult> {
    const collectedEvents: Event[] = []

    const taskText =
      session.events
        .filter(isUserEvent)
        .map((e) => e.text)
        .pop() ?? ''

    if (!taskText) {
      return { status: 'errored', error: 'No task provided', events: [] }
    }

    try {
      const handle = agent.run({ task: taskText, signal: abortController.signal })

      for await (const event of handle) {
        if (abortController.signal.aborted) break
        collectedEvents.push(event as Event)
        await this.sessionService.appendEvent(session, event as Event)
        onEvent(event)
      }

      await this.sessionService.commitSession(session)

      const result = await handle

      switch (result.status) {
        case 'completed':
          return { status: 'completed', events: collectedEvents }
        case 'error':
          return {
            status: 'errored',
            error: result.error?.message ?? 'Unknown error',
            events: collectedEvents,
          }
        case 'aborted':
          return { status: 'completed', events: collectedEvents }
        default:
          return { status: 'sleeping', events: collectedEvents }
      }
    } catch (err) {
      await this.sessionService.commitSession(session).catch(() => {})
      return {
        status: 'errored',
        error: err instanceof Error ? err.message : String(err),
        events: collectedEvents,
      }
    }
  }

  private async completeWithError(processId: string, error: string): Promise<void> {
    await this.processStore.update(this.appName, processId, {
      status: 'completed',
      nextWakeAt: null,
      metadata: { error },
    })

    this.emitCompletion(processId, 'running')

    // Clean up executor resources
    const process = await this.processStore.get(this.appName, processId)
    if (process) {
      const executor = this.getExecutor(process.executor)
      await executor.cleanup?.(processId)
    }
  }

  private getExecutor(executorName: string | null): Executor {
    if (!executorName) {
      return this.defaultExecutor
    }
    const executor = this.executors.get(executorName)
    if (!executor) {
      throw new Error(`Executor '${executorName}' not found`)
    }
    return executor
  }

  private getOrCreateSubscription(processId: string): ProcessSubscription {
    let subscription = this.subscriptions.get(processId)
    if (!subscription) {
      subscription = { subscribers: new Set(), emittedEvents: [] }
      this.subscriptions.set(processId, subscription)
    }
    return subscription
  }

  private emitProcessEvent(processId: string, event: ProcessEvent): void {
    const subscription = this.getOrCreateSubscription(processId)
    subscription.emittedEvents.push(event)
    for (const subscriber of subscription.subscribers) {
      try {
        subscriber(event)
      } catch (err) {
        console.error(`Gateway: subscriber error for process ${processId}:`, err)
      }
    }
  }

  private emitCompletion(processId: string, previousStatus: ProcessStatus): void {
    this.emitProcessEvent(processId, {
      type: 'status_change',
      status: 'completed',
      previousStatus,
    })
    this.emitProcessEvent(processId, {
      type: 'completed',
      finalStatus: 'completed',
    })
  }

  async listWorkspaceFiles(processId: string): Promise<string[] | null> {
    const process = await this.processStore.get(this.appName, processId)
    if (!process) {
      return null
    }

    const executor = this.getExecutor(process.executor)
    if (!executor.listWorkspaceFiles) {
      return null
    }

    return executor.listWorkspaceFiles(processId)
  }

  injectEvent(processId: string, event: ProcessEvent): void {
    this.emitProcessEvent(processId, event)
  }
}

/** Create a new gateway instance. */
export function createGateway(config: GatewayConfig): Gateway {
  return new GatewayImpl(config)
}
