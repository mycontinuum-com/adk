/**
 * ProcessStore Types
 *
 * Types for the process runtime's persistence layer. A process is a scheduling/lifecycle wrapper
 * around a session. The session stores events (what happened). The process stores lifecycle
 * metadata (when to run, what state it's in).
 */

/**
 * Process status in the lifecycle state machine.
 *
 *     dispatch() ─▶ SLEEPING ─▶ QUEUED ─▶ RUNNING ─▶ SLEEPING
 *                      │                     │           │
 *                      │                     ▼           ▼
 *                      │                  (error →   COMPLETED
 *                      │                   revert)
 *                      └─────────────────────────────────┘
 */
export type ProcessStatus = 'sleeping' | 'queued' | 'running' | 'completed'

/** A stored process record. */
export interface StoredProcess {
  id: string
  appName: string
  agentName: string
  sessionId: string
  status: ProcessStatus
  /** When true, scheduling is suppressed (human takeover) */
  paused: boolean
  /** Cron expression or interval for scheduled wakes */
  schedule: string | null
  nextWakeAt: Date | null
  /** Executor name for routing (e.g., 'in-process', 'modal') */
  executor: string | null
  executorConfig: Record<string, unknown>
  lastRunAt: Date | null
  createdAt: Date
  metadata: Record<string, unknown>
}

/** Partial update to a process. Only specified fields are updated. */
export interface ProcessUpdate {
  status?: ProcessStatus
  paused?: boolean
  schedule?: string | null
  nextWakeAt?: Date | null
  executor?: string | null
  executorConfig?: Record<string, unknown>
  lastRunAt?: Date | null
  metadata?: Record<string, unknown>
}

/** A message waiting for delivery to a process inbox. */
export interface StoredMessage {
  id: string
  processId: string
  payload: unknown
  /** Author identity for audit trails */
  authorId: string | null
  authorName: string | null
  createdAt: Date
  consumed: boolean
}

/** Filter criteria for listing processes. */
export interface ProcessFilter {
  status?: ProcessStatus | ProcessStatus[]
  agentName?: string
  paused?: boolean
  executor?: string
  limit?: number
  offset?: number
}

/** Summary view of a process for listing. */
export type ProcessSummary = Pick<
  StoredProcess,
  | 'id'
  | 'appName'
  | 'agentName'
  | 'sessionId'
  | 'status'
  | 'paused'
  | 'createdAt'
  | 'lastRunAt'
  | 'nextWakeAt'
>

/**
 * Storage backend interface for process lifecycle management.
 *
 * All methods are scoped by `appName` for multi-tenant isolation. Implementations must pass
 * `runProcessStoreTests()`.
 *
 * The process store's core operation is a cross-partition query ("find all sleeping processes where
 * `nextWakeAt <= NOW()`"), which is fundamentally a SQL workload.
 */
export interface ProcessStore {
  /** Create a new process. Fails if process already exists. */
  create(process: StoredProcess): Promise<void>

  /** Get a process by ID. Returns null if not found. */
  get(appName: string, processId: string): Promise<StoredProcess | null>

  /** Update a process. Merges changes with existing data. Throws if process does not exist. */
  update(appName: string, processId: string, changes: ProcessUpdate): Promise<void>

  /**
   * Atomically claim sleeping processes that are due to wake.
   *
   * Finds processes where:
   *
   * - Status = 'sleeping'
   * - Paused = false
   * - NextWakeAt <= NOW()
   *
   * Sets their status to 'queued' and returns them. The partial index makes this cheap regardless
   * of total process count.
   */
  claimDue(appName: string, limit: number): Promise<StoredProcess[]>

  /**
   * Revert stale queued processes back to sleeping.
   *
   * Finds processes where: - status = 'queued' - claimed more than `timeoutMs` ago
   *
   * Returns the number of processes reverted. This handles crashed workers that never transitioned
   * to 'running'.
   */
  revertStale(appName: string, timeoutMs: number): Promise<number>

  /**
   * Enqueue a message for a process.
   *
   * Writes the message AND sets `nextWakeAt = NOW()` in one transaction, so the next poll cycle
   * picks it up immediately.
   */
  enqueueMessage(
    appName: string,
    processId: string,
    message: Omit<StoredMessage, 'processId' | 'consumed'>,
  ): Promise<void>

  /**
   * Consume all pending messages for a process.
   *
   * Marks messages as consumed and returns them. If the turn fails, consumed messages are not
   * re-delivered — the agent sees them in session history on the next attempt.
   */
  consumeMessages(appName: string, processId: string): Promise<StoredMessage[]>

  /** List processes matching filter criteria. */
  list(appName: string, filter?: ProcessFilter): Promise<ProcessSummary[]>

  /** Delete a process and its associated messages. */
  delete(appName: string, processId: string): Promise<void>

  /** Close the store and release resources. */
  close(): Promise<void>
}
