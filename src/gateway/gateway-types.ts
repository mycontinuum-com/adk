/**
 * Gateway Types
 *
 * Types for the process runtime gateway — process lifecycle, executors, and event subscription.
 */

import type { CodingAgent } from '../agents/coding/types'
import type { ArtifactService } from '../artifacts/types'
import type { StreamEvent, Event } from '../types/events'
import type { Agent } from '../types/runnables'
import type { SessionStore, Session } from '../types/session'
import type { ProcessStore, StoredProcess, ProcessStatus } from './types'

// ──────────────────────────────────────────────────────��──────────────────────
// Dispatch & Send Options
// ─────────────────────────────────────────────────────────────────────────────

/** Options for dispatching a new process. */
export interface DispatchOptions {
  /** Initial input for the agent (task description, user message, etc.) */
  input?: unknown
  /** Explicit session ID. If omitted, a new session is created. */
  sessionId?: string
  /** Metadata to attach to the process record. */
  metadata?: Record<string, unknown>
  /** Executor name (defaults to gateway's default executor). */
  executor?: string
  /** Executor-specific configuration. */
  executorConfig?: Record<string, unknown>
}

/** Options for sending a message to a process. */
export interface SendOptions {
  /** Author identity for audit trails. */
  author?: {
    id: string
    name: string
    email?: string
  }
}

/** Options for subscribing to process events. */
export interface SubscribeOptions {
  /**
   * Event ID to resume from. If provided, returns events after this ID. If undefined, returns all
   * historical events plus live events.
   */
  after?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Events
// ─────────────────────────────────────────────────────────────────────────────

/** Event types emitted by the gateway's subscribe() method. */
export type ProcessEvent =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'status_change'; status: ProcessStatus; previousStatus?: ProcessStatus }
  | { type: 'completed'; finalStatus: ProcessStatus }

// ─────────────────────────────────────────────────────────────────────────────
// Executor Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Request to execute a turn for a process. */
export interface ExecutionRequest {
  process: StoredProcess
  session: Session
  agent: Agent
  messages: Array<{ payload: unknown; authorId?: string; authorName?: string }>
  signal: AbortSignal
}

/** Result of executing a turn. */
export interface ExecutionResult {
  /** New status for the process. */
  status: 'sleeping' | 'completed' | 'errored'
  /**
   * Next wake time if status is 'sleeping'. - undefined = sleep forever (no scheduled wake, waits
   * for message) - Date = wake at this time (for scheduled processes)
   */
  nextWakeAt?: Date
  /** Error message if status is 'errored'. */
  error?: string
  /** Session events emitted during this turn. */
  events: Event[]
  /** Executor-specific config updates (e.g. containerId, tunnelHost) to persist on the process. */
  executorConfig?: Record<string, unknown>
}

/**
 * Executor interface — executes turns for processes.
 *
 * The Gateway uses executors to run agent turns. Different executors provide different isolation
 * models: - InProcessExecutor: Runs in the gateway's own process (dev/test) - DockerExecutor: Runs
 * in local Docker containers (local dev with isolation) - ModalExecutor: Runs in Modal sandboxes
 * (production) - LocalWorkerExecutor: Runs on developer machines (IDE integration)
 */
export interface Executor {
  /** Executor name for routing. */
  readonly name: string

  /**
   * Execute a turn for a process.
   *
   * Called by the gateway after claiming a process. The executor: 1. Sets up execution context
   * (workspace, knowledge, etc.) 2. Runs the agent for one turn 3. Returns the result with new
   * status
   *
   * Events should be emitted via the provided callback during execution for real-time streaming to
   * subscribers.
   *
   * @param request Execution request with process, session, agent, messages
   * @param onEvent Callback to emit events during execution
   * @returns Execution result with new status and any error
   */
  execute(
    request: ExecutionRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ExecutionResult>

  /**
   * Clean up resources for a completed/errored process. Called when a process reaches a terminal
   * state.
   */
  cleanup?(processId: string): Promise<void>

  /**
   * Get the preview URL for a running process.
   *
   * Returns a URL where the process's dev server can be accessed: - DockerExecutor:
   * `http://localhost:PORT` - ModalExecutor: `https://xxx.modal.run`
   *
   * @param processId Process to get preview URL for
   * @returns Preview URL or null if not available
   */
  getPreviewUrl?(processId: string): Promise<string | null>

  /**
   * List files in the workspace for a process.
   *
   * Used for @autocomplete in the dashboard chat input. Returns relative paths from the workspace
   * root.
   *
   * @param processId Process to list files for
   * @returns Array of file paths or null if workspace not available
   */
  listWorkspaceFiles?(processId: string): Promise<string[] | null>
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Process status response for gw.status(). */
export interface ProcessStatusResponse {
  id: string
  agentName: string
  sessionId: string
  status: ProcessStatus
  paused: boolean
  createdAt: Date
  lastRunAt: Date | null
  nextWakeAt: Date | null
  executor: string | null
  executorConfig: Record<string, unknown>
  metadata: Record<string, unknown>
  /** Current artifact names and latest versions (if artifact service configured). */
  artifacts?: Array<{ name: string; version: number; mimeType: string }>
}

/** Gateway configuration. */
export interface GatewayConfig {
  /** Application name for multi-tenant isolation. */
  appName: string
  /** Process store for lifecycle persistence. */
  processStore: ProcessStore
  /** Session store for event persistence. */
  sessionStore: SessionStore
  /** Artifact service for artifact storage (optional). */
  artifactService?: ArtifactService
  /** Default executor for new processes. */
  defaultExecutor: Executor
  /** Additional executors keyed by name. */
  executors?: Record<string, Executor>
  agents: Map<string, Agent | CodingAgent> | Record<string, Agent | CodingAgent>
  /** Timeout for stale process detection in milliseconds. Default: 60000 (1 minute). */
  staleTimeoutMs?: number
}

/**
 * Gateway — process lifecycle management.
 *
 * The gateway is the central coordination point for process execution: - dispatch(): Create new
 * processes - send(): Wake sleeping processes with messages - subscribe(): Stream events (live +
 * historical) - status(): Get process state - stop(): Terminate a process - start(): Begin the poll
 * loop - shutdown(): Stop the poll loop and clean up
 */
export interface Gateway {
  /**
   * Dispatch a new process.
   *
   * Creates a process record, session, and immediately wakes it for execution.
   *
   * @param agentName Name of the agent to run
   * @param options Dispatch options (input, sessionId, metadata, etc.)
   * @returns Process ID
   */
  dispatch(agentName: string, options?: DispatchOptions): Promise<string>

  /**
   * Send a message to a process.
   *
   * Enqueues a message in the process inbox and wakes it immediately. Works only for sleeping
   * processes — throws if process is running or completed.
   *
   * @param processId Target process
   * @param payload Message payload
   * @param options Send options (author identity)
   */
  send(processId: string, payload: unknown, options?: SendOptions): Promise<void>

  /**
   * Subscribe to process events.
   *
   * Returns an async iterator that yields: - Historical events (from session store) if `after` is
   * not specified - Live events as they occur during execution - Status change events when process
   * status changes - A completed event when the process reaches a terminal state
   *
   * @param processId Process to subscribe to
   * @param options Subscribe options (after cursor)
   */
  subscribe(processId: string, options?: SubscribeOptions): AsyncIterable<ProcessEvent>

  /**
   * Get process status.
   *
   * @param processId Process to query
   * @returns Process status or null if not found
   */
  status(processId: string): Promise<ProcessStatusResponse | null>

  /**
   * Stop a process.
   *
   * Marks the process as completed (or errored if running). If the process is currently running,
   * signals the executor to abort.
   *
   * @param processId Process to stop
   */
  stop(processId: string): Promise<void>

  /**
   * Start the gateway poll loop.
   *
   * The poll loop:
   *
   * 1. Claims due processes (sleeping with nextWakeAt <= now)
   * 2. Executes turns via the appropriate executor
   * 3. Updates process status based on execution result
   * 4. Reverts stale processes (queued too long without starting)
   *
   * @param options Poll interval in milliseconds (default: 1000)
   */
  start(options?: { intervalMs?: number }): void

  shutdown(): Promise<void>

  listWorkspaceFiles(processId: string): Promise<string[] | null>
  injectEvent(processId: string, event: ProcessEvent): void
}
