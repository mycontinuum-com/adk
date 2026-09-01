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

import type { Event } from '../types/events'
import type { SessionStore, StoredSession, CommitResult, ScopedStateChange } from '../types/session'

export interface DynamoDBStoreConfig {
  tableName: string
  client?: DynamoDBClientConfig
  partitionKey?: string
  sortKey?: string
}

type Item = Record<string, unknown>

const META_SK = 'meta'
const MAX_BATCH_RETRIES = 5

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

  constructor(config: DynamoDBStoreConfig) {
    this.tableName = config.tableName
    this.pkName = config.partitionKey ?? 'pk'
    this.skName = config.sortKey ?? 'sk'
    const client = new DynamoDBClient(config.client ?? {})
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    })
  }

  private pk(appName: string, id: string): string {
    return `${appName}#${id}`
  }

  private scopePk(appName: string, scope: string, scopeId: string): string {
    return `${appName}#${scope}#${scopeId}`
  }

  private async queryAll(input: QueryCommandInput): Promise<Item[]> {
    const items: Item[] = []
    let exclusiveStartKey: Item | undefined

    do {
      const result = await this.doc.send(
        new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
      )
      if (result.Items) items.push(...(result.Items as Item[]))
      exclusiveStartKey = result.LastEvaluatedKey as Item | undefined
    } while (exclusiveStartKey)

    return items
  }

  private async batchWrite(requests: Item[]): Promise<void> {
    const batches: Item[][] = []
    for (let i = 0; i < requests.length; i += 25) {
      batches.push(requests.slice(i, i + 25))
    }

    for (const batch of batches) {
      let unprocessed: Item[] | undefined = batch
      for (
        let attempt = 0;
        attempt < MAX_BATCH_RETRIES && unprocessed && unprocessed.length > 0;
        attempt++
      ) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 50))
        }
        const result = await this.doc.send(
          new BatchWriteCommand({
            RequestItems: { [this.tableName]: unprocessed },
          }),
        )
        unprocessed = result.UnprocessedItems?.[this.tableName] as Item[] | undefined
      }
      if (unprocessed && unprocessed.length > 0) {
        throw new Error(
          `DynamoDB BatchWrite failed: ${unprocessed.length} items unprocessed after ${MAX_BATCH_RETRIES} retries`,
        )
      }
    }
  }

  async load(
    appName: string,
    sessionId: string,
  ): Promise<{ session: StoredSession; events: Event[] } | null> {
    const pk = this.pk(appName, sessionId)

    const items = await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': this.pkName },
      ExpressionAttributeValues: { ':pk': pk },
    })

    if (items.length === 0) return null

    const metaItem = items.find((i) => i[this.skName] === META_SK)
    if (!metaItem) return null

    const session: StoredSession = {
      id: sessionId,
      appName,
      version: num(metaItem, 'version'),
      scopes: (metaItem.scopes ?? {}) as Record<string, string>,
      createdAt: num(metaItem, 'createdAt'),
    }

    const eventItems = items.filter((i) => i[this.skName] !== META_SK)
    const events: Event[] = eventItems
      .toSorted((a, b) => num(a, 'v') - num(b, 'v') || num(a, 'seq') - num(b, 'seq'))
      .map((i) => JSON.parse(str(i, 'data')))

    return { session, events }
  }

  async commit(
    session: StoredSession,
    newEvents: Event[],
    expectedVersion: number,
    scopedChanges?: ScopedStateChange[],
  ): Promise<CommitResult> {
    const pk = this.pk(session.appName, session.id)
    const newVersion = expectedVersion + 1

    try {
      await this.doc.send(
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
      )
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        const current = await this.doc.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { [this.pkName]: pk, [this.skName]: META_SK },
          }),
        )
        return {
          ok: false,
          conflict: true,
          currentVersion: num(current.Item ?? {}, 'version'),
        }
      }
      throw err
    }

    const writes: Promise<void>[] = []

    if (newEvents.length > 0) {
      writes.push(
        this.batchWrite(
          newEvents.map((evt, i) => ({
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
        writes.push(this.saveScopedState(session.appName, scope, scopeId, changes))
      }
    }

    if (writes.length > 0) await Promise.all(writes)

    return { ok: true, version: newVersion }
  }

  async delete(appName: string, sessionId: string): Promise<void> {
    const pk = this.pk(appName, sessionId)

    const items = await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': this.pkName, '#sk': this.skName },
      ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: '#pk, #sk',
    })

    if (items.length === 0) return

    await this.batchWrite(
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
    const items = await this.queryAll({
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
    const pk = this.scopePk(appName, scope, scopeId)
    const entries = Object.entries(state)
    if (entries.length === 0) return

    await this.batchWrite(
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
    let exclusiveStartKey: Item | undefined

    do {
      const result = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression:
            '#sk = :meta AND begins_with(#pk, :prefix) AND attribute_exists(version)',
          ExpressionAttributeNames: { '#pk': this.pkName, '#sk': this.skName },
          ExpressionAttributeValues: { ':meta': META_SK, ':prefix': prefix },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      )
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
