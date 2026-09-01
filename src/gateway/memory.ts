/** In-memory ProcessStore for tests and local development. */

import type {
  ProcessStore,
  StoredProcess,
  StoredMessage,
  ProcessUpdate,
  ProcessFilter,
  ProcessSummary,
} from './types'

/** Create an in-memory process store. */
export function inMemoryProcessStore(): ProcessStore {
  return new InMemoryProcessStore()
}

export class InMemoryProcessStore implements ProcessStore {
  private processes = new Map<string, StoredProcess & { claimedAt?: Date }>()
  private messages = new Map<string, StoredMessage[]>()

  private key(appName: string, processId: string): string {
    return `${appName}#${processId}`
  }

  async create(process: StoredProcess): Promise<void> {
    const k = this.key(process.appName, process.id)
    if (this.processes.has(k)) {
      throw new Error(`Process ${process.id} already exists in app ${process.appName}`)
    }
    this.processes.set(k, structuredClone(process))
  }

  async get(appName: string, processId: string): Promise<StoredProcess | null> {
    const k = this.key(appName, processId)
    const process = this.processes.get(k)
    if (!process) return null
    // Return a clean copy without internal fields
    const { claimedAt: _, ...clean } = process
    return structuredClone(clean)
  }

  async update(appName: string, processId: string, changes: ProcessUpdate): Promise<void> {
    const k = this.key(appName, processId)
    const existing = this.processes.get(k)
    if (!existing) {
      throw new Error(`Process ${processId} not found in app ${appName}`)
    }

    // Merge changes
    if (changes.status !== undefined) existing.status = changes.status
    if (changes.paused !== undefined) existing.paused = changes.paused
    if (changes.schedule !== undefined) existing.schedule = changes.schedule
    if (changes.nextWakeAt !== undefined) existing.nextWakeAt = changes.nextWakeAt
    if (changes.executor !== undefined) existing.executor = changes.executor
    if (changes.executorConfig !== undefined) {
      existing.executorConfig = structuredClone(changes.executorConfig)
    }
    if (changes.lastRunAt !== undefined) existing.lastRunAt = changes.lastRunAt
    if (changes.metadata !== undefined) {
      existing.metadata = { ...existing.metadata, ...structuredClone(changes.metadata) }
    }

    // Track when queued for stale detection
    if (changes.status === 'queued') {
      existing.claimedAt = new Date()
    } else if (changes.status !== undefined) {
      // Any status change away from 'queued' clears the claimed timestamp
      existing.claimedAt = undefined
    }
  }

  async claimDue(appName: string, limit: number): Promise<StoredProcess[]> {
    const now = new Date()
    const claimed: StoredProcess[] = []

    for (const [key, process] of this.processes) {
      if (claimed.length >= limit) break
      if (!key.startsWith(`${appName}#`)) continue

      if (
        process.status === 'sleeping' &&
        !process.paused &&
        process.nextWakeAt &&
        process.nextWakeAt <= now
      ) {
        process.status = 'queued'
        process.claimedAt = now
        const { claimedAt: _, ...clean } = process
        claimed.push(structuredClone(clean))
      }
    }

    return claimed
  }

  async revertStale(appName: string, timeoutMs: number): Promise<number> {
    const now = Date.now()
    let reverted = 0

    for (const [key, process] of this.processes) {
      if (!key.startsWith(`${appName}#`)) continue

      if (
        process.status === 'queued' &&
        process.claimedAt &&
        now - process.claimedAt.getTime() > timeoutMs
      ) {
        process.status = 'sleeping'
        process.claimedAt = undefined
        reverted++
      }
    }

    return reverted
  }

  async enqueueMessage(
    appName: string,
    processId: string,
    message: Omit<StoredMessage, 'processId' | 'consumed'>,
  ): Promise<void> {
    const k = this.key(appName, processId)
    const process = this.processes.get(k)
    if (!process) {
      throw new Error(`Process ${processId} not found in app ${appName}`)
    }

    // Store the message
    const fullMessage: StoredMessage = {
      ...structuredClone(message),
      processId,
      consumed: false,
    }

    const messageList = this.messages.get(k) ?? []
    messageList.push(fullMessage)
    this.messages.set(k, messageList)

    // Wake the process immediately if sleeping and not paused
    if (process.status === 'sleeping' && !process.paused) {
      process.nextWakeAt = new Date()
    }
  }

  async consumeMessages(appName: string, processId: string): Promise<StoredMessage[]> {
    const k = this.key(appName, processId)
    const messageList = this.messages.get(k)
    if (!messageList) {
      return []
    }

    const pending = messageList.filter((m) => !m.consumed)
    for (const msg of pending) {
      msg.consumed = true
    }

    return structuredClone(pending)
  }

  async list(appName: string, filter?: ProcessFilter): Promise<ProcessSummary[]> {
    const results: ProcessSummary[] = []

    for (const [key, process] of this.processes) {
      if (!key.startsWith(`${appName}#`)) continue

      // Apply filters
      if (filter?.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        if (!statuses.includes(process.status)) continue
      }
      if (filter?.agentName && process.agentName !== filter.agentName) continue
      if (filter?.paused !== undefined && process.paused !== filter.paused) continue
      if (filter?.executor && process.executor !== filter.executor) continue

      results.push({
        id: process.id,
        appName: process.appName,
        agentName: process.agentName,
        sessionId: process.sessionId,
        status: process.status,
        paused: process.paused,
        createdAt: process.createdAt,
        lastRunAt: process.lastRunAt,
        nextWakeAt: process.nextWakeAt,
      })
    }

    // Sort by createdAt descending (most recent first)
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    // Apply pagination
    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? results.length
    return results.slice(offset, offset + limit)
  }

  async delete(appName: string, processId: string): Promise<void> {
    const k = this.key(appName, processId)
    this.processes.delete(k)
    this.messages.delete(k)
  }

  async close(): Promise<void> {
    // No resources to release for in-memory store
  }
}
