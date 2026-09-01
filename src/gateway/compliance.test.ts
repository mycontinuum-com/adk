/**
 * ProcessStore Compliance Test Suite
 *
 * All backends must pass this test battery.
 */

import type { ProcessStore, StoredProcess, StoredMessage } from './types'

import { InMemoryProcessStore } from './memory'

function makeProcess(overrides?: Partial<StoredProcess>): StoredProcess {
  const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    appName: 'test-app',
    agentName: 'test-agent',
    sessionId: `session-${id}`,
    status: 'sleeping',
    paused: false,
    schedule: null,
    nextWakeAt: null,
    executor: null,
    executorConfig: {},
    lastRunAt: null,
    createdAt: new Date(),
    metadata: {},
    ...overrides,
  }
}

function makeMessage(
  overrides?: Partial<Omit<StoredMessage, 'processId' | 'consumed'>>,
): Omit<StoredMessage, 'processId' | 'consumed'> {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload: { text: 'Hello' },
    authorId: null,
    authorName: null,
    createdAt: new Date(),
    ...overrides,
  }
}

export function runProcessStoreTests(
  name: string,
  createStore: () => ProcessStore,
  cleanup?: () => Promise<void>,
) {
  describe(`${name} — ProcessStore compliance`, () => {
    let store: ProcessStore

    beforeEach(() => {
      store = createStore()
    })

    afterEach(async () => {
      await store.close()
      await cleanup?.()
    })

    describe('create/get', () => {
      test('creates and retrieves a process', async () => {
        const now = new Date()
        const process = makeProcess({
          id: 'test-1',
          agentName: 'my-agent',
          paused: true,
          schedule: '0 * * * *',
          nextWakeAt: now,
          executor: 'modal',
          executorConfig: { region: 'us-west' },
          metadata: { issueId: 'MT-123' },
        })
        await store.create(process)

        const loaded = await store.get('test-app', 'test-1')
        expect(loaded).toMatchObject({
          id: 'test-1',
          agentName: 'my-agent',
          paused: true,
          schedule: '0 * * * *',
          executor: 'modal',
          executorConfig: { region: 'us-west' },
          metadata: { issueId: 'MT-123' },
        })
        expect(loaded!.nextWakeAt?.getTime()).toBe(now.getTime())
      })

      test('returns null for non-existent process', async () => {
        expect(await store.get('test-app', 'missing')).toBeNull()
      })

      test('throws on duplicate within same app', async () => {
        await store.create(makeProcess({ id: 'dup' }))
        await expect(store.create(makeProcess({ id: 'dup' }))).rejects.toThrow()
      })

      test('isolates by appName', async () => {
        await store.create(makeProcess({ id: 'shared', appName: 'app1' }))
        await store.create(makeProcess({ id: 'shared', appName: 'app2' }))

        expect((await store.get('app1', 'shared'))!.appName).toBe('app1')
        expect((await store.get('app2', 'shared'))!.appName).toBe('app2')
      })

      test('returns deep clone', async () => {
        await store.create(makeProcess({ id: 'clone', metadata: { nested: { x: 1 } } }))
        const loaded = await store.get('test-app', 'clone')
        ;(loaded!.metadata.nested as any).x = 999

        expect((await store.get('test-app', 'clone'))!.metadata).toEqual({ nested: { x: 1 } })
      })
    })

    describe('update', () => {
      test('throws for non-existent process', async () => {
        await expect(store.update('test-app', 'missing', { status: 'running' })).rejects.toThrow()
      })

      test('updates individual fields', async () => {
        await store.create(makeProcess({ id: 'upd' }))
        const wakeTime = new Date(Date.now() + 60000)

        await store.update('test-app', 'upd', {
          status: 'running',
          paused: true,
          nextWakeAt: wakeTime,
          executor: 'modal',
          executorConfig: { sandbox: 'large' },
        })

        const loaded = await store.get('test-app', 'upd')
        expect(loaded).toMatchObject({
          status: 'running',
          paused: true,
          executor: 'modal',
          executorConfig: { sandbox: 'large' },
        })
        expect(loaded!.nextWakeAt?.getTime()).toBe(wakeTime.getTime())
      })

      test('merges metadata', async () => {
        await store.create(makeProcess({ id: 'meta', metadata: { a: 1, b: 2 } }))
        await store.update('test-app', 'meta', { metadata: { b: 20, c: 3 } })

        expect((await store.get('test-app', 'meta'))!.metadata).toEqual({ a: 1, b: 20, c: 3 })
      })

      test('can set nextWakeAt to null', async () => {
        await store.create(makeProcess({ id: 'null-wake', nextWakeAt: new Date() }))
        await store.update('test-app', 'null-wake', { nextWakeAt: null })

        expect((await store.get('test-app', 'null-wake'))!.nextWakeAt).toBeNull()
      })
    })

    describe('claimDue', () => {
      test('claims sleeping processes with due wake time', async () => {
        const past = new Date(Date.now() - 1000)
        await store.create(makeProcess({ id: 'due-1', nextWakeAt: past }))
        await store.create(makeProcess({ id: 'due-2', nextWakeAt: past }))

        const claimed = await store.claimDue('test-app', 10)
        expect(claimed).toHaveLength(2)
        expect(claimed.every((p) => p.status === 'queued')).toBe(true)

        // Verify persisted
        expect((await store.get('test-app', 'due-1'))!.status).toBe('queued')
      })

      test('respects limit', async () => {
        const past = new Date(Date.now() - 1000)
        await store.create(makeProcess({ id: 'l1', nextWakeAt: past }))
        await store.create(makeProcess({ id: 'l2', nextWakeAt: past }))
        await store.create(makeProcess({ id: 'l3', nextWakeAt: past }))

        expect(await store.claimDue('test-app', 2)).toHaveLength(2)
      })

      test('skips paused, future, non-sleeping, and null wake', async () => {
        const past = new Date(Date.now() - 1000)
        const future = new Date(Date.now() + 60000)

        await store.create(makeProcess({ id: 'paused', nextWakeAt: past, paused: true }))
        await store.create(makeProcess({ id: 'future', nextWakeAt: future }))
        await store.create(makeProcess({ id: 'running', nextWakeAt: past, status: 'running' }))
        await store.create(makeProcess({ id: 'no-wake', nextWakeAt: null }))

        expect(await store.claimDue('test-app', 10)).toHaveLength(0)
      })
    })

    describe('revertStale', () => {
      test('reverts queued processes older than timeout', async () => {
        const past = new Date(Date.now() - 1000)
        await store.create(makeProcess({ id: 'stale', nextWakeAt: past }))
        await store.claimDue('test-app', 10)

        await new Promise((r) => setTimeout(r, 50))
        expect(await store.revertStale('test-app', 10)).toBe(1)
        expect((await store.get('test-app', 'stale'))!.status).toBe('sleeping')
      })

      test('does not revert fresh or non-queued', async () => {
        const past = new Date(Date.now() - 1000)
        await store.create(makeProcess({ id: 'fresh', nextWakeAt: past }))
        await store.create(makeProcess({ id: 'running', status: 'running' }))
        await store.claimDue('test-app', 10)

        expect(await store.revertStale('test-app', 60000)).toBe(0)
      })
    })

    describe('messages', () => {
      test('enqueue throws for non-existent process', async () => {
        await expect(store.enqueueMessage('test-app', 'missing', makeMessage())).rejects.toThrow()
      })

      test('enqueue wakes sleeping process', async () => {
        await store.create(makeProcess({ id: 'wake', nextWakeAt: null }))
        const before = Date.now()
        await store.enqueueMessage('test-app', 'wake', makeMessage())

        const loaded = await store.get('test-app', 'wake')
        expect(loaded!.nextWakeAt!.getTime()).toBeGreaterThanOrEqual(before)
      })

      test('enqueue does not wake paused process', async () => {
        await store.create(makeProcess({ id: 'paused', nextWakeAt: null, paused: true }))
        await store.enqueueMessage('test-app', 'paused', makeMessage())

        expect((await store.get('test-app', 'paused'))!.nextWakeAt).toBeNull()
      })

      test('consume returns and marks messages with all fields', async () => {
        await store.create(makeProcess({ id: 'msgs' }))
        const msgTime = new Date()
        await store.enqueueMessage('test-app', 'msgs', {
          id: 'm1',
          payload: { type: 'feedback' },
          authorId: 'user-1',
          authorName: 'Alice',
          createdAt: msgTime,
        })
        await store.enqueueMessage('test-app', 'msgs', makeMessage({ id: 'm2' }))

        const first = await store.consumeMessages('test-app', 'msgs')
        expect(first.map((m) => m.id)).toEqual(['m1', 'm2'])
        expect(first.every((m) => m.consumed)).toBe(true)
        expect(first[0]).toMatchObject({
          payload: { type: 'feedback' },
          authorId: 'user-1',
          authorName: 'Alice',
        })
        expect(first[0].createdAt.getTime()).toBe(msgTime.getTime())

        expect(await store.consumeMessages('test-app', 'msgs')).toHaveLength(0)
      })

      test('consume returns empty for non-existent process', async () => {
        expect(await store.consumeMessages('test-app', 'missing')).toEqual([])
      })
    })

    describe('list', () => {
      test('filters by status, agentName, paused, executor', async () => {
        await store.create(
          makeProcess({
            id: 'a',
            status: 'sleeping',
            agentName: 'x',
            paused: false,
            executor: 'modal',
          }),
        )
        await store.create(
          makeProcess({
            id: 'b',
            status: 'running',
            agentName: 'y',
            paused: true,
            executor: 'local',
          }),
        )

        expect((await store.list('test-app', { status: 'running' })).map((p) => p.id)).toEqual([
          'b',
        ])
        expect(await store.list('test-app', { status: ['sleeping', 'running'] })).toHaveLength(2)
        expect((await store.list('test-app', { agentName: 'x' })).map((p) => p.id)).toEqual(['a'])
        expect((await store.list('test-app', { paused: true })).map((p) => p.id)).toEqual(['b'])
        expect((await store.list('test-app', { executor: 'modal' })).map((p) => p.id)).toEqual([
          'a',
        ])
      })

      test('supports limit/offset and sorts by createdAt desc', async () => {
        await store.create(makeProcess({ id: 'old', createdAt: new Date('2024-01-01') }))
        await store.create(makeProcess({ id: 'new', createdAt: new Date('2024-06-01') }))

        const all = await store.list('test-app')
        expect(all.map((p) => p.id)).toEqual(['new', 'old'])

        expect((await store.list('test-app', { limit: 1 })).map((p) => p.id)).toEqual(['new'])
        expect((await store.list('test-app', { limit: 1, offset: 1 })).map((p) => p.id)).toEqual([
          'old',
        ])
      })
    })

    describe('delete', () => {
      test('removes process and messages', async () => {
        await store.create(makeProcess({ id: 'del' }))
        await store.enqueueMessage('test-app', 'del', makeMessage())
        await store.delete('test-app', 'del')

        expect(await store.get('test-app', 'del')).toBeNull()

        // Re-create to verify messages gone
        await store.create(makeProcess({ id: 'del' }))
        expect(await store.consumeMessages('test-app', 'del')).toHaveLength(0)
      })

      test('does not throw for non-existent', async () => {
        await expect(store.delete('test-app', 'missing')).resolves.toBeUndefined()
      })
    })

    test('close can be called multiple times', async () => {
      await store.close()
      await store.close()
    })
  })
}

runProcessStoreTests('InMemoryProcessStore', () => new InMemoryProcessStore())
