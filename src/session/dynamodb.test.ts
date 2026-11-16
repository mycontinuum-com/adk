import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserEvent } from '../types/events'
import type { CommitResult } from '../types/session'

import { BaseSession } from './base'
import { DynamoDBStore, DynamoDBStoreTimeoutError } from './dynamodb'
import { sessionService } from './service'

const TABLE = 'sessions'
const BATCH = 25
const MAX_ATTEMPTS = 10
const FIRST_RETRY_BOUND_MS = 100
const COMMITTED: CommitResult = { ok: true, version: 1 }

type Request = Record<string, unknown>
type Reply = { unprocessed?: number } | { throw: string }
type Outcome = { value: CommitResult } | { error: Error }

interface Call {
  at: number
  items: Request[]
}

function events(count: number): UserEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    type: 'user',
    createdAt: 0,
    text: `${i}`,
  }))
}

/**
 * Stubs the document client's `send`: the meta PutItem succeeds, and each BatchWriteItem takes its
 * reply from `replies` in turn (all processed once they run out), refusing the last `unprocessed`
 * items of the request or throwing an error with the given name.
 */
function stubDynamo(replies: Reply[]): Call[] {
  const calls: Call[] = []
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
    if (!(command instanceof BatchWriteCommand)) return {}
    const items: Request[] = command.input.RequestItems?.[TABLE] ?? []
    calls.push({ at: Date.now(), items })
    const reply = replies.shift() ?? {}
    if ('throw' in reply) {
      throw Object.assign(new Error(reply.throw), { name: reply.throw })
    }
    const refused = reply.unprocessed ? items.slice(items.length - reply.unprocessed) : []
    return refused.length > 0 ? { UnprocessedItems: { [TABLE]: refused } } : {}
  })
  return calls
}

function refusals(count: number, unprocessed: number): Reply[] {
  return Array.from({ length: count }, () => ({ unprocessed }))
}

async function commitEvents(count: number): Promise<Outcome> {
  const store = new DynamoDBStore({
    tableName: TABLE,
    client: { region: 'eu-west-2' },
  })
  const session = {
    id: 's1',
    appName: 'app',
    version: 0,
    scopes: {},
    createdAt: 0,
  }
  const done = store.commit(session, events(count), 0).then(
    (value): Outcome => ({ value }),
    (error: Error): Outcome => ({ error }),
  )
  await vi.runAllTimersAsync()
  return done
}

function errorOf(outcome: Outcome): Error {
  if (!('error' in outcome)) throw new Error('expected the commit to fail')
  return outcome.error
}

describe('DynamoDBStore batch writes under throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps retrying a refused batch past five attempts', async () => {
    const refusedAttempts = 7
    const calls = stubDynamo(refusals(refusedAttempts, BATCH))

    const outcome = await commitEvents(BATCH)

    expect(outcome).toEqual({ value: COMMITTED })
    expect(calls).toHaveLength(refusedAttempts + 1)
  })

  it('waits a random share of the backoff before each retry', async () => {
    const share = 0.5
    vi.spyOn(Math, 'random').mockReturnValue(share)
    const calls = stubDynamo(refusals(2, BATCH))

    await commitEvents(BATCH)

    const firstWait = share * FIRST_RETRY_BOUND_MS
    const secondWait = share * FIRST_RETRY_BOUND_MS * 2
    expect(calls.map((c) => c.at)).toEqual([0, firstWait, firstWait + secondWait])
  })

  it('pauses before the next batch when the last one was refused', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const refused = 5
    const calls = stubDynamo([{ unprocessed: refused }])

    await commitEvents(BATCH * 2)

    expect(calls.map((c) => [c.at, c.items.length])).toEqual([
      [0, BATCH],
      [FIRST_RETRY_BOUND_MS, refused],
      [FIRST_RETRY_BOUND_MS * 2, BATCH],
    ])
  })

  it('sends the next batch at once when nothing was refused', async () => {
    const remainder = 10
    const calls = stubDynamo([])

    await commitEvents(BATCH * 2 + remainder)

    expect(calls.map((c) => [c.at, c.items.length])).toEqual([
      [0, BATCH],
      [0, BATCH],
      [0, remainder],
    ])
  })

  it('leaves a request the SDK gave up on as throttled to the caller', async () => {
    const name = 'ProvisionedThroughputExceededException'
    const calls = stubDynamo([{ throw: name }])

    const error = errorOf(await commitEvents(BATCH))

    expect(error.name).toBe(name)
    expect(calls).toHaveLength(1)
  })

  it('fails a batch that is still refused after the attempt budget', async () => {
    const refused = 3
    const calls = stubDynamo(refusals(MAX_ATTEMPTS * 2, refused))

    const error = errorOf(await commitEvents(BATCH))

    expect(error.message).toBe(
      `DynamoDB BatchWrite failed: ${refused} items unprocessed after ${MAX_ATTEMPTS} attempts`,
    )
    expect(calls).toHaveLength(MAX_ATTEMPTS)
  })

  it('does not retry an error that is not throttling', async () => {
    const name = 'ValidationException'
    const calls = stubDynamo([{ throw: name }])

    const error = errorOf(await commitEvents(BATCH))

    expect(error.name).toBe(name)
    expect(calls).toHaveLength(1)
  })
})

type Row = Record<string, unknown>

/**
 * Stubs the document client's `send` with an in-memory table that answers the commands the store
 * sends, and counts the event rows each partition receives through BatchWriteItem.
 */
function fakeTable(): {
  eventWrites: Map<string, number>
  rows: Map<string, Row>
} {
  const rows = new Map<string, Row>()
  const eventWrites = new Map<string, number>()
  const key = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
    if (command instanceof PutCommand) {
      const item = command.input.Item ?? {}
      rows.set(key(item.pk, item.sk), item)
      return {}
    }
    if (command instanceof GetCommand) {
      const k = command.input.Key ?? {}
      return { Item: rows.get(key(k.pk, k.sk)) }
    }
    if (command instanceof QueryCommand) {
      const pk = command.input.ExpressionAttributeValues?.[':pk']
      return { Items: [...rows.values()].filter((row) => row.pk === pk) }
    }
    if (command instanceof BatchWriteCommand) {
      for (const request of command.input.RequestItems?.[TABLE] ?? []) {
        const item = request.PutRequest?.Item
        if (!item) continue
        rows.set(key(item.pk, item.sk), item)
        eventWrites.set(String(item.pk), (eventWrites.get(String(item.pk)) ?? 0) + 1)
      }
      return {}
    }
    return {}
  })
  return { eventWrites, rows }
}

const APP = 'app'
const PARENT_EVENTS = 60
const FORK_AT = 40
const MAX_FORK_DEPTH = 32

async function storedParent(eventCount: number) {
  const table = fakeTable()
  const service = sessionService(
    new DynamoDBStore({ tableName: TABLE, client: { region: 'eu-west-2' } }),
  )
  const parent = await service.createSession(APP)
  for (const event of events(eventCount)) (parent as BaseSession).pushEvent(event)
  await service.commitSession(parent)
  return { service, parent, ...table }
}

function addedEvent(id: string): UserEvent {
  return { id, type: 'user', createdAt: 0, text: id }
}

describe('DynamoDBStore fork index', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes only the events added after the fork point', async () => {
    const { service, parent, eventWrites } = await storedParent(PARENT_EVENTS)
    const fork = parent.forkAt(FORK_AT)
    const added: UserEvent = {
      id: 'evt-added',
      type: 'user',
      createdAt: 0,
      text: 'added',
    }
    ;(fork as BaseSession).pushEvent(added)

    await service.commitSession(fork, 0)

    expect(eventWrites.get(`${APP}#${fork.id}`)).toBe(1)
    const loaded = await service.getSession(APP, fork.id)
    expect(loaded?.events.map((e) => e.id)).toEqual([
      ...parent.events.slice(0, FORK_AT + 1).map((e) => e.id),
      added.id,
    ])
    expect(loaded?.forkedFrom).toEqual({
      sessionId: parent.id,
      throughEventId: parent.events[FORK_AT].id,
    })
  })

  it('copies every event when the parent has not stored the fork point', async () => {
    const { eventWrites } = fakeTable()
    const service = sessionService(
      new DynamoDBStore({ tableName: TABLE, client: { region: 'eu-west-2' } }),
    )
    const unsaved = new BaseSession(APP)
    for (const event of events(PARENT_EVENTS)) unsaved.pushEvent(event)
    const fork = unsaved.forkAt(FORK_AT)

    await service.commitSession(fork, 0)

    expect(eventWrites.get(`${APP}#${fork.id}`)).toBe(FORK_AT + 1)
    const loaded = await service.getSession(APP, fork.id)
    expect(loaded?.events).toHaveLength(FORK_AT + 1)
  })

  it("does not write a saved fork's inherited events again when a clone of it commits", async () => {
    const { service, parent, eventWrites } = await storedParent(PARENT_EVENTS)
    const fork = parent.forkAt(FORK_AT)
    await service.commitSession(fork, 0)
    const reloaded = await service.getSession(APP, fork.id)
    if (!reloaded) throw new Error('expected the fork to load')
    const clone = (reloaded as BaseSession).clone()
    const later = addedEvent('evt-clone')
    clone.pushEvent(later)

    const result = await service.commitSession(clone)

    expect(result).toEqual({ ok: true, version: 2 })
    expect(eventWrites.get(`${APP}#${fork.id}`)).toBe(1)
    const loaded = await service.getSession(APP, fork.id)
    expect(loaded?.events.map((e) => e.id)).toEqual([
      ...parent.events.slice(0, FORK_AT + 1).map((e) => e.id),
      later.id,
    ])
  })

  it("keeps the fork index on a fork's later commits", async () => {
    const { service, parent } = await storedParent(PARENT_EVENTS)
    const fork = parent.forkAt(FORK_AT)
    await service.commitSession(fork, 0)
    const reloaded = await service.getSession(APP, fork.id)
    const later: UserEvent = {
      id: 'evt-later',
      type: 'user',
      createdAt: 0,
      text: 'later',
    }
    ;(reloaded as BaseSession).pushEvent(later)

    if (!reloaded) throw new Error('expected the fork to load')
    await service.commitSession(reloaded)

    const loaded = await service.getSession(APP, fork.id)
    expect(loaded?.events).toHaveLength(FORK_AT + 2)
    expect(loaded?.events.at(-1)?.id).toBe(later.id)
  })

  it('points a fork of a fork at the session that stores the event', async () => {
    const { service, parent, eventWrites } = await storedParent(PARENT_EVENTS)
    const first = parent.forkAt(FORK_AT)
    await service.commitSession(first, 0)
    const loadedFirst = await service.getSession(APP, first.id)
    if (!loadedFirst) throw new Error('expected the first fork to load')
    const earlier = FORK_AT / 2

    const second = loadedFirst.forkAt(earlier)
    await service.commitSession(second, 0)

    expect(eventWrites.get(`${APP}#${second.id}`)).toBeUndefined()
    const loaded = await service.getSession(APP, second.id)
    expect(loaded?.forkedFrom?.sessionId).toBe(parent.id)
    expect(loaded?.events.map((e) => e.id)).toEqual(
      parent.events.slice(0, earlier + 1).map((e) => e.id),
    )
  })

  it('copies the events of a fork that would pass the fork depth limit', async () => {
    const { service, parent, eventWrites } = await storedParent(1)
    let tip = parent
    for (let depth = 1; depth <= MAX_FORK_DEPTH + 1; depth++) {
      const fork = tip.forkAt(tip.events.length - 1)
      ;(fork as BaseSession).pushEvent(addedEvent(`evt-depth-${depth}`))
      await service.commitSession(fork, 0)
      const loaded = await service.getSession(APP, fork.id)
      if (!loaded) throw new Error(`expected the fork at depth ${depth} to load`)
      expect(loaded.events).toHaveLength(depth + 1)
      tip = loaded
    }

    expect(eventWrites.get(`${APP}#${tip.id}`)).toBe(MAX_FORK_DEPTH + 2)
  })
})

const OPERATION_TIMEOUT_MS = 1000
const REQUEST_TIMEOUT_MS = 960

function timedStore(): DynamoDBStore {
  return new DynamoDBStore({
    tableName: TABLE,
    client: { region: 'eu-west-2' },
    operationTimeoutMs: OPERATION_TIMEOUT_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  })
}

/** A reply that never comes: it settles only when the request is cancelled, with the time it was. */
function hang(options: unknown, cancelledAt: number[]): Promise<never> {
  const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => {
      cancelledAt.push(Date.now())
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  })
}

async function settle<T>(work: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  const done = work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  await vi.runAllTimersAsync()
  return await done
}

describe('DynamoDBStore deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('cancels a read that never answers at the request timeout, as unavailable', async () => {
    const cancelledAt: number[] = []
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(
      async (_command, options) => await hang(options, cancelledAt),
    )

    const outcome = await settle(timedStore().load(APP, 's1'))

    expect(outcome).toEqual({
      error: new DynamoDBStoreTimeoutError('unavailable', OPERATION_TIMEOUT_MS),
    })
    expect(cancelledAt).toEqual([REQUEST_TIMEOUT_MS])
  })

  it('gives a retry only the time left on the operation, as indeterminate after a write', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const firstWait = 0.5 * FIRST_RETRY_BOUND_MS
    const cancelledAt: number[] = []
    let batches = 0
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(
      async (command, options) => {
        if (!(command instanceof BatchWriteCommand)) return {}
        batches++
        if (batches > 1) return await hang(options, cancelledAt)
        return {
          UnprocessedItems: {
            [TABLE]: command.input.RequestItems?.[TABLE] ?? [],
          },
        }
      },
    )
    const session = {
      id: 's1',
      appName: APP,
      version: 0,
      scopes: {},
      createdAt: 0,
    }

    const outcome = await settle(timedStore().commit(session, events(BATCH), 0))

    expect(outcome).toEqual({
      error: new DynamoDBStoreTimeoutError('indeterminate', OPERATION_TIMEOUT_MS),
    })
    expect(firstWait + REQUEST_TIMEOUT_MS).toBeGreaterThan(OPERATION_TIMEOUT_MS)
    expect(cancelledAt).toEqual([OPERATION_TIMEOUT_MS])
  })

  it('does not wait or send again once the operation has no time left', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const sentAt: number[] = []
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
      if (!(command instanceof BatchWriteCommand)) return {}
      sentAt.push(Date.now())
      return {
        UnprocessedItems: {
          [TABLE]: command.input.RequestItems?.[TABLE] ?? [],
        },
      }
    })
    const session = {
      id: 's1',
      appName: APP,
      version: 0,
      scopes: {},
      createdAt: 0,
    }

    const outcome = await settle(timedStore().commit(session, events(BATCH), 0))

    expect(outcome).toEqual({
      error: new DynamoDBStoreTimeoutError('indeterminate', OPERATION_TIMEOUT_MS),
    })
    // Waits of 100, 200 and 400 ms fit in the second; the next, 800 ms, would pass it.
    expect(sentAt).toEqual([0, 100, 300, 700])
  })
})
