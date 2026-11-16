import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  GetCommand,
  BatchWriteCommand,
  ScanCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { z } from 'zod'

import type { Event } from '../types/events'
import type { SessionStore, StoredSession, CommitResult, ScopedStateChange } from '../types/session'

export interface DynamoDBStoreConfig {
  tableName: string
  client?: DynamoDBClientConfig
  partitionKey?: string
  sortKey?: string
  /**
   * Time one store operation (a load, commit, delete or list) may take, including its retries and
   * backoff. Default 10000.
   */
  operationTimeoutMs?: number
  /** Longest a single DynamoDB request may take, within the operation's time. Default 3000. */
  requestTimeoutMs?: number
}

/**
 * Thrown when a store operation runs out of time. `indeterminate`: the operation had sent a write,
 * so the table may hold some of its changes. `unavailable`: it had written nothing.
 */
export class DynamoDBStoreTimeoutError extends Error {
  readonly outcome: 'unavailable' | 'indeterminate'

  constructor(outcome: 'unavailable' | 'indeterminate', timeoutMs: number) {
    super(`DynamoDB session store operation did not finish within ${timeoutMs}ms (${outcome})`)
    this.name = 'DynamoDBStoreTimeoutError'
    this.outcome = outcome
  }
}

type Item = Record<string, unknown>

const META_SK = 'meta'
/** Sort key of a fork's index row, written once by the fork's first commit. */
const FORK_SK = 'fork'
/** Longest chain of forks a fork index may reach through; a deeper fork copies its events. */
const MAX_FORK_DEPTH = 32
const MAX_BATCH_ATTEMPTS = 10
const BASE_BACKOFF_MS = 50
const MAX_BACKOFF_MS = 1000
// A person waiting on a session tends to give up after about 10 s. DynamoDB answers in single-digit
// milliseconds, so only a stalled table or a long throttled write reaches either limit.
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000

/** One store operation's deadline, which every request, retry and backoff of it spends from. */
interface Operation {
  readonly endsAt: number
  readonly timeoutMs: number
  /** Set once the operation sends a write, after which running out of time is indeterminate. */
  wrote: boolean
}

/**
 * A fork's index row: the session that stores `throughEventId`, which the fork's history runs up
 * to, and how many forks lie between this one and a session that holds all of its own events.
 */
const forkIndexSchema = z.object({
  sessionId: z.string(),
  throughEventId: z.string(),
  depth: z.number().int().positive(),
})
type ForkIndex = z.infer<typeof forkIndexSchema>

function timedOut(op: Operation): DynamoDBStoreTimeoutError {
  return new DynamoDBStoreTimeoutError(op.wrote ? 'indeterminate' : 'unavailable', op.timeoutMs)
}

/**
 * Full jitter: a random wait up to an exponential bound, so retries of many writers spread out.
 * Fails at once when the wait would pass the operation's deadline.
 */
function backoff(op: Operation, retry: number): Promise<void> {
  const ms = Math.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retry)
  if (Date.now() + ms >= op.endsAt) return Promise.reject(timedOut(op))
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function str(item: Item, key: string): string {
  return String(item[key] ?? '')
}

function num(item: Item, key: string): number {
  return Number(item[key] ?? 0)
}

/**
 * Create a DynamoDB session store. Requires `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb`
 * as peer dependencies.
 */
export function dynamoStore(config: DynamoDBStoreConfig): SessionStore {
  return new DynamoDBStore(config)
}

/**
 * DynamoDB SessionStore — single-table design.
 *
 * Event sort keys are UUIDs, not integer indexes. Integer indexes require a single writer —
 * concurrent runtimes that both load at eventCount=5 would silently overwrite each other's events
 * via BatchWriteItem. UUIDs never collide.
 *
 * Event ordering uses (v, seq): `v` is the session version from the OCC gate, `seq` is the 0-based
 * index within the commit batch. Both are available at commit time with zero extra reads. A global
 * counter would require read-before-write (racy).
 *
 * Fork index: a forked session's first commit writes a `fork` row naming the session that stores
 * the last event it inherits, instead of copying the inherited events, which would land hundreds of
 * writes on the new partition in under a second and throttle. That session is the nearest one along
 * the fork chain whose own rows hold the event, so rewinding a fork again to an earlier step points
 * past it. `load` reads the inherited events from that session with consistent reads. A fork copies
 * every event, as before, when no session along the chain stores the event or the chain would pass
 * `MAX_FORK_DEPTH`. Deleting a session makes the forks that index it unloadable.
 *
 * Atomicity caveat: metadata PutItem (OCC gate) executes first. Events and scoped state follow in
 * parallel via BatchWriteItem. If metadata succeeds but writes fail, the version has advanced but
 * events are missing. Not transactional across items.
 *
 * @deprecated Use `dynamoStore()` instead. Will be removed from the public API in the next major
 *   version.
 */
export class DynamoDBStore implements SessionStore {
  private doc: DynamoDBDocumentClient
  private tableName: string
  private pkName: string
  private skName: string
  private operationTimeoutMs: number
  private requestTimeoutMs: number

  constructor(config: DynamoDBStoreConfig) {
    this.tableName = config.tableName
    this.pkName = config.partitionKey ?? 'pk'
    this.skName = config.sortKey ?? 'sk'
    this.operationTimeoutMs = config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const client = new DynamoDBClient(config.client ?? {})
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    })
  }

  private begin(): Operation {
    return {
      endsAt: Date.now() + this.operationTimeoutMs,
      timeoutMs: this.operationTimeoutMs,
      wrote: false,
    }
  }

  /**
   * Sends one request with a timeout of the smaller of `requestTimeoutMs` and the operation's time
   * left, cancelling it when that passes. A deadline already passed fails before the request
   * starts.
   */
  private async send<T>(request: {
    op: Operation
    write: boolean
    run: (options: { abortSignal: AbortSignal }) => Promise<T>
  }): Promise<T> {
    const { op } = request
    const left = op.endsAt - Date.now()
    if (left <= 0) throw timedOut(op)
    if (request.write) op.wrote = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(this.requestTimeoutMs, left))
    try {
      return await request.run({ abortSignal: controller.signal })
    } catch (err: unknown) {
      if (controller.signal.aborted) throw timedOut(op)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private pk(appName: string, id: string): string {
    return `${appName}#${id}`
  }

  private scopePk(appName: string, scope: string, scopeId: string): string {
    return `${appName}#${scope}#${scopeId}`
  }

  private async queryAll(op: Operation, input: QueryCommandInput): Promise<Item[]> {
    const items: Item[] = []
    let exclusiveStartKey: Item | undefined

    do {
      const startKey = exclusiveStartKey
      const result = await this.send({
        op,
        write: false,
        run: (options) =>
          this.doc.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }), options),
      })
      if (result.Items) items.push(...(result.Items as Item[]))
      exclusiveStartKey = result.LastEvaluatedKey as Item | undefined
    } while (exclusiveStartKey)

    return items
  }

  /**
   * Writes in batches of 25, which DynamoDB may refuse in part when one partition takes writes
   * faster than it allows, as a forked session's events do. Each refused batch is retried with
   * jittered backoff, and a batch that needed retries makes the next one wait as long as its last
   * retry might, so a large write slows to the rate the partition accepts instead of running out of
   * attempts.
   */
  private async batchWrite(op: Operation, requests: Item[]): Promise<void> {
    let retriesBefore = 0

    for (let i = 0; i < requests.length; i += 25) {
      if (retriesBefore > 0) await backoff(op, retriesBefore)
      let unprocessed: Item[] = requests.slice(i, i + 25)
      let attempt = 0
      while (unprocessed.length > 0 && attempt < MAX_BATCH_ATTEMPTS) {
        if (attempt > 0) await backoff(op, attempt)
        attempt++
        const batch = unprocessed
        // Only refused items are retried here: the SDK already retries a request that throws.
        const result = await this.send({
          op,
          write: true,
          run: (options) =>
            this.doc.send(
              new BatchWriteCommand({
                RequestItems: { [this.tableName]: batch },
              }),
              options,
            ),
        })
        unprocessed = (result.UnprocessedItems?.[this.tableName] as Item[] | undefined) ?? []
      }
      if (unprocessed.length > 0) {
        throw new Error(
          `DynamoDB BatchWrite failed: ${unprocessed.length} items unprocessed after ${MAX_BATCH_ATTEMPTS} attempts`,
        )
      }
      retriesBefore = attempt - 1
    }
  }

  async load(
    appName: string,
    sessionId: string,
  ): Promise<{ session: StoredSession; events: Event[] } | null> {
    return await this.loadSession({
      op: this.begin(),
      appName,
      sessionId,
      depth: 0,
      consistent: false,
    })
  }

  private async loadSession(target: {
    op: Operation
    appName: string
    sessionId: string
    depth: number
    consistent: boolean
  }): Promise<{ session: StoredSession; events: Event[] } | null> {
    const { op, appName, sessionId } = target
    const items = await this.queryAll(op, {
      TableName: this.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': this.pkName },
      ExpressionAttributeValues: { ':pk': this.pk(appName, sessionId) },
      ConsistentRead: target.consistent,
    })

    if (items.length === 0) return null

    const metaItem = items.find((i) => i[this.skName] === META_SK)
    if (!metaItem) return null

    const forkItem = items.find((i) => i[this.skName] === FORK_SK)
    const fork = forkItem ? forkIndexSchema.parse(forkItem) : undefined
    const session: StoredSession = {
      id: sessionId,
      appName,
      version: num(metaItem, 'version'),
      scopes: (metaItem.scopes ?? {}) as Record<string, string>,
      createdAt: num(metaItem, 'createdAt'),
      ...(fork && {
        forkedFrom: {
          sessionId: fork.sessionId,
          throughEventId: fork.throughEventId,
        },
      }),
    }

    const own: Event[] = items
      .filter((i) => i[this.skName] !== META_SK && i[this.skName] !== FORK_SK)
      .toSorted((a, b) => num(a, 'v') - num(b, 'v') || num(a, 'seq') - num(b, 'seq'))
      .map((i) => JSON.parse(str(i, 'data')))

    if (!fork) return { session, events: own }
    const inherited = await this.inheritedEvents({
      op,
      appName,
      sessionId,
      depth: target.depth,
      fork,
    })
    return { session, events: [...inherited, ...own] }
  }

  private async inheritedEvents(child: {
    op: Operation
    appName: string
    sessionId: string
    depth: number
    fork: ForkIndex
  }): Promise<Event[]> {
    const { op, appName, sessionId, depth, fork } = child
    if (depth >= MAX_FORK_DEPTH) {
      throw new Error(
        `DynamoDB session ${sessionId}: fork chain is deeper than ${MAX_FORK_DEPTH} sessions`,
      )
    }
    const owner = await this.loadSession({
      op,
      appName,
      sessionId: fork.sessionId,
      depth: depth + 1,
      consistent: true,
    })
    const through = owner?.events.findIndex((e) => e.id === fork.throughEventId) ?? -1
    if (!owner || through < 0) {
      throw new Error(
        `DynamoDB session ${sessionId}: session ${fork.sessionId} no longer holds event ${fork.throughEventId}`,
      )
    }
    return owner.events.slice(0, through + 1)
  }

  private async getItem(key: {
    op: Operation
    appName: string
    sessionId: string
    sk: string
  }): Promise<Item | undefined> {
    const result = await this.send({
      op: key.op,
      write: false,
      run: (options) =>
        this.doc.send(
          new GetCommand({
            TableName: this.tableName,
            Key: {
              [this.pkName]: this.pk(key.appName, key.sessionId),
              [this.skName]: key.sk,
            },
            ConsistentRead: true,
          }),
          options,
        ),
    })
    return result.Item
  }

  /**
   * The session whose own rows hold `eventId`, found from `sessionId` by following fork indexes
   * back, with that session's fork depth; undefined when no session along the chain holds it.
   */
  private async eventOwner(start: {
    op: Operation
    appName: string
    sessionId: string
    eventId: string
  }): Promise<{ sessionId: string; depth: number } | undefined> {
    const { op, appName, eventId } = start
    let candidate = start.sessionId
    for (let step = 0; step <= MAX_FORK_DEPTH; step++) {
      const [forkItem, event] = await Promise.all([
        this.getItem({ op, appName, sessionId: candidate, sk: FORK_SK }),
        this.getItem({ op, appName, sessionId: candidate, sk: eventId }),
      ])
      const fork = forkItem ? forkIndexSchema.parse(forkItem) : undefined
      if (event) return { sessionId: candidate, depth: fork?.depth ?? 0 }
      if (!fork) return undefined
      candidate = fork.sessionId
    }
    return undefined
  }

  /**
   * The events a commit writes, and the fork index to write instead of the rest: a fork's first
   * commit skips the events it inherits when a session along its chain stores the last of them
   * within `MAX_FORK_DEPTH`, and a later commit never writes them again.
   */
  private async ownEvents(commit: {
    op: Operation
    session: StoredSession
    newEvents: Event[]
    expectedVersion: number
  }): Promise<{ events: Event[]; fork?: ForkIndex }> {
    const { session, newEvents } = commit
    const origin = session.forkedFrom
    if (!origin) return { events: newEvents }
    const through = newEvents.findIndex((e) => e.id === origin.throughEventId)
    if (through < 0) return { events: newEvents }
    // A later commit that resends the fork's history, as a clone's first commit does, already has
    // the events through the fork point stored: through the index, or copied by the first commit.
    if (commit.expectedVersion !== 0) return { events: newEvents.slice(through + 1) }
    const owner = await this.eventOwner({
      op: commit.op,
      appName: session.appName,
      sessionId: origin.sessionId,
      eventId: origin.throughEventId,
    })
    if (!owner || owner.depth >= MAX_FORK_DEPTH) return { events: newEvents }
    return {
      events: newEvents.slice(through + 1),
      fork: {
        sessionId: owner.sessionId,
        throughEventId: origin.throughEventId,
        depth: owner.depth + 1,
      },
    }
  }

  async commit(
    session: StoredSession,
    newEvents: Event[],
    expectedVersion: number,
    scopedChanges?: ScopedStateChange[],
  ): Promise<CommitResult> {
    const pk = this.pk(session.appName, session.id)
    const newVersion = expectedVersion + 1
    const op = this.begin()
    const { events, fork } = await this.ownEvents({
      op,
      session,
      newEvents,
      expectedVersion,
    })

    try {
      await this.send({
        op,
        write: true,
        run: (options) =>
          this.doc.send(
            new PutCommand({
              TableName: this.tableName,
              Item: {
                [this.pkName]: pk,
                [this.skName]: META_SK,
                version: newVersion,
                scopes: session.scopes ?? {},
                createdAt: session.createdAt,
                updatedAt: Date.now(),
              },
              ConditionExpression:
                expectedVersion === 0 ? `attribute_not_exists(#pk)` : 'version = :ev',
              ...(expectedVersion === 0
                ? { ExpressionAttributeNames: { '#pk': this.pkName } }
                : { ExpressionAttributeValues: { ':ev': expectedVersion } }),
            }),
            options,
          ),
      })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        // The refused put changed nothing, so a timeout reading the current version is unavailable.
        op.wrote = false
        const current = await this.send({
          op,
          write: false,
          run: (options) =>
            this.doc.send(
              new GetCommand({
                TableName: this.tableName,
                Key: { [this.pkName]: pk, [this.skName]: META_SK },
              }),
              options,
            ),
        })
        return {
          ok: false,
          conflict: true,
          currentVersion: num(current.Item ?? {}, 'version'),
        }
      }
      throw err
    }

    const writes: Promise<void>[] = []

    if (fork) {
      writes.push(
        this.send({
          op,
          write: true,
          run: (options) =>
            this.doc.send(
              new PutCommand({
                TableName: this.tableName,
                Item: { [this.pkName]: pk, [this.skName]: FORK_SK, ...fork },
              }),
              options,
            ),
        }).then(() => {}),
      )
    }

    if (events.length > 0) {
      writes.push(
        this.batchWrite(
          op,
          events.map((evt, i) => ({
            PutRequest: {
              Item: {
                [this.pkName]: pk,
                [this.skName]: evt.id,
                data: JSON.stringify(evt),
                v: newVersion,
                seq: i,
              },
            },
          })),
        ),
      )
    }

    if (scopedChanges) {
      for (const { scope, scopeId, changes } of scopedChanges) {
        writes.push(
          this.writeScopedState({
            op,
            appName: session.appName,
            scope,
            scopeId,
            state: changes,
          }),
        )
      }
    }

    if (writes.length > 0) await Promise.all(writes)

    return { ok: true, version: newVersion }
  }

  async delete(appName: string, sessionId: string): Promise<void> {
    const pk = this.pk(appName, sessionId)
    const op = this.begin()

    const items = await this.queryAll(op, {
      TableName: this.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': this.pkName, '#sk': this.skName },
      ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: '#pk, #sk',
    })

    if (items.length === 0) return

    await this.batchWrite(
      op,
      items.map((item) => ({
        DeleteRequest: {
          Key: {
            [this.pkName]: item[this.pkName],
            [this.skName]: item[this.skName],
          },
        },
      })),
    )
  }

  async loadScopedState(
    appName: string,
    scope: string,
    scopeId: string,
  ): Promise<Record<string, unknown>> {
    const items = await this.queryAll(this.begin(), {
      TableName: this.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': this.pkName },
      ExpressionAttributeValues: {
        ':pk': this.scopePk(appName, scope, scopeId),
      },
    })

    const state: Record<string, unknown> = {}
    for (const item of items) {
      state[str(item, this.skName)] = JSON.parse(str(item, 'value'))
    }
    return state
  }

  async saveScopedState(
    appName: string,
    scope: string,
    scopeId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.writeScopedState({
      op: this.begin(),
      appName,
      scope,
      scopeId,
      state,
    })
  }

  private async writeScopedState(target: {
    op: Operation
    appName: string
    scope: string
    scopeId: string
    state: Record<string, unknown>
  }): Promise<void> {
    const pk = this.scopePk(target.appName, target.scope, target.scopeId)
    const entries = Object.entries(target.state)
    if (entries.length === 0) return

    await this.batchWrite(
      target.op,
      entries.map(([key, value]) =>
        value === undefined
          ? {
              DeleteRequest: { Key: { [this.pkName]: pk, [this.skName]: key } },
            }
          : {
              PutRequest: {
                Item: {
                  [this.pkName]: pk,
                  [this.skName]: key,
                  value: JSON.stringify(value),
                },
              },
            },
      ),
    )
  }

  async close(): Promise<void> {}

  /**
   * Lists an app's sessions with a table Scan — the key layout has no app-level partition, so this
   * reads the whole table. Fine at this store's intended scale; add a GSI over a dedicated app-name
   * attribute before relying on it for a large table. Session meta rows are identified by their
   * `meta` sort key plus a `version` attribute (scoped-state rows carry neither), and the pk prefix
   * assumes app names do not contain `#`.
   */
  async list(appName: string): Promise<Array<{ id: string; updatedAt: number }>> {
    const prefix = `${appName}#`
    const sessions: Array<{ id: string; updatedAt: number }> = []
    const op = this.begin()
    let exclusiveStartKey: Item | undefined

    do {
      const startKey = exclusiveStartKey
      const result = await this.send({
        op,
        write: false,
        run: (options) =>
          this.doc.send(
            new ScanCommand({
              TableName: this.tableName,
              FilterExpression:
                '#sk = :meta AND begins_with(#pk, :prefix) AND attribute_exists(version)',
              ExpressionAttributeNames: {
                '#pk': this.pkName,
                '#sk': this.skName,
              },
              ExpressionAttributeValues: {
                ':meta': META_SK,
                ':prefix': prefix,
              },
              ExclusiveStartKey: startKey,
            }),
            options,
          ),
      })
      for (const item of (result.Items ?? []) as Item[]) {
        sessions.push({
          id: str(item, this.pkName).slice(prefix.length),
          updatedAt: num(item, 'updatedAt'),
        })
      }
      exclusiveStartKey = result.LastEvaluatedKey as Item | undefined
    } while (exclusiveStartKey)

    return sessions.toSorted((a, b) => b.updatedAt - a.updatedAt)
  }
}
