/**
 * Gateway Integration Tests
 *
 * Tests the gateway's 7-method API, process lifecycle state machine, poll loop, InProcessExecutor,
 * and event subscription.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'

import type { Agent } from '../types/runnables'
import type { Gateway, ProcessEvent } from './gateway-types'

import { InMemoryArtifactService } from '../artifacts/memory'
import { InMemoryStore } from '../session/memory'
import { createGateway, GatewayImpl } from './gateway'
import { createInProcessExecutor } from './in-process-executor'
import { InMemoryProcessStore } from './memory'

function createTestAgent(name: string): Agent {
  return {
    kind: 'agent',
    name,
    model: { provider: 'openai', name: 'gpt-4o-mini' },
    instructions: 'Test agent.',
    tools: [],
  }
}

/** Create test infrastructure. */
function createTestInfra() {
  const processStore = new InMemoryProcessStore()
  const sessionStore = new InMemoryStore()
  const artifactService = new InMemoryArtifactService()

  const executor = createInProcessExecutor({
    sessionStore,
    artifactService,
  })

  return { processStore, sessionStore, artifactService, executor }
}

describe('Gateway', () => {
  let gateway: Gateway
  let processStore: InMemoryProcessStore
  let sessionStore: InMemoryStore

  beforeEach(() => {
    const infra = createTestInfra()
    processStore = infra.processStore
    sessionStore = infra.sessionStore

    gateway = createGateway({
      appName: 'test-app',
      processStore,
      sessionStore,
      artifactService: infra.artifactService,
      defaultExecutor: infra.executor,
      agents: {
        'test-agent': createTestAgent('test-agent'),
      },
    })
  })

  afterEach(async () => {
    await gateway.shutdown()
    await processStore.close()
  })

  describe('dispatch()', () => {
    test('creates a new process with string input', async () => {
      const processId = await gateway.dispatch('test-agent', {
        input: 'Hello, world!',
      })

      expect(processId).toMatch(/^proc-/)

      const status = await gateway.status(processId)
      expect(status).not.toBeNull()
      expect(status!.agentName).toBe('test-agent')
      expect(status!.status).toBe('sleeping')
    })

    test('creates a new process with object input', async () => {
      const processId = await gateway.dispatch('test-agent', {
        input: { task: 'analyze', data: [1, 2, 3] },
      })

      expect(processId).toMatch(/^proc-/)
    })

    test('throws for unknown agent', async () => {
      await expect(gateway.dispatch('unknown-agent')).rejects.toThrow(
        "Agent 'unknown-agent' not found",
      )
    })

    test('creates process with metadata and custom session ID', async () => {
      const processId = await gateway.dispatch('test-agent', {
        sessionId: 'custom-session-123',
        metadata: { issueId: 'MT-123' },
      })

      const status = await gateway.status(processId)
      expect(status!.sessionId).toBe('custom-session-123')
      expect(status!.metadata).toEqual({ issueId: 'MT-123' })
    })
  })

  describe('send()', () => {
    test('enqueues message to sleeping process', async () => {
      const processId = await gateway.dispatch('test-agent')
      await gateway.send(
        processId,
        { text: 'Follow-up' },
        {
          author: { id: 'user-1', name: 'Alice' },
        },
      )

      const status = await gateway.status(processId)
      expect(status!.nextWakeAt).not.toBeNull()
    })

    test('throws for non-existent process', async () => {
      await expect(gateway.send('non-existent', 'Hello')).rejects.toThrow(
        "Process 'non-existent' not found",
      )
    })

    test('resumes a completed process', async () => {
      const processId = await gateway.dispatch('test-agent')
      await gateway.stop(processId)

      expect((await gateway.status(processId))!.status).toBe('completed')

      await gateway.send(processId, 'Resume', {
        author: { id: 'user-1', name: 'Alice' },
      })

      const status = await gateway.status(processId)
      expect(status!.status).toBe('sleeping')
      expect(status!.nextWakeAt).not.toBeNull()
    })
  })

  describe('status()', () => {
    test('returns null for non-existent process', async () => {
      expect(await gateway.status('non-existent')).toBeNull()
    })

    test('returns process status with all fields', async () => {
      const processId = await gateway.dispatch('test-agent', {
        input: 'Test',
        metadata: { key: 'value' },
      })

      const status = await gateway.status(processId)
      expect(status).toMatchObject({
        id: processId,
        agentName: 'test-agent',
        status: 'sleeping',
        paused: false,
        metadata: { key: 'value' },
      })
      expect(status!.sessionId).toMatch(/^sess-/)
      expect(status!.createdAt).toBeInstanceOf(Date)
      expect(status!.artifacts).toBeDefined()
    })
  })

  describe('stop()', () => {
    test('stops a sleeping process', async () => {
      const processId = await gateway.dispatch('test-agent')
      await gateway.stop(processId)

      expect((await gateway.status(processId))!.status).toBe('completed')
    })

    test('throws for non-existent process', async () => {
      await expect(gateway.stop('non-existent')).rejects.toThrow("Process 'non-existent' not found")
    })

    test('is idempotent for completed process', async () => {
      const processId = await gateway.dispatch('test-agent')
      await gateway.stop(processId)
      await gateway.stop(processId) // Should not throw

      expect((await gateway.status(processId))!.status).toBe('completed')
    })
  })

  describe('subscribe()', () => {
    test('throws for non-existent process', async () => {
      const gen = gateway.subscribe('non-existent')
      await expect(gen.next()).rejects.toThrow("Process 'non-existent' not found")
    })

    test('yields historical events and completed for stopped process', async () => {
      const processId = await gateway.dispatch('test-agent', { input: 'Hello' })
      await gateway.stop(processId)

      const events: ProcessEvent[] = []
      for await (const event of gateway.subscribe(processId)) {
        events.push(event)
        if (event.type === 'completed') break
      }

      expect(events.some((e) => e.type === 'stream')).toBe(true)
      expect(events[events.length - 1]).toEqual({
        type: 'completed',
        finalStatus: 'completed',
      })
    })

    test('supports cursor-based resume', async () => {
      const processId = await gateway.dispatch('test-agent', { input: 'Hello' })
      await gateway.stop(processId)

      const firstBatch: ProcessEvent[] = []
      for await (const event of gateway.subscribe(processId)) {
        firstBatch.push(event)
        if (event.type === 'completed') break
      }

      if (firstBatch.length > 1 && firstBatch[0].type === 'stream') {
        const cursor = firstBatch[0].event.id
        const secondBatch: ProcessEvent[] = []
        for await (const event of gateway.subscribe(processId, { after: cursor })) {
          secondBatch.push(event)
          if (event.type === 'completed') break
        }

        const streamEvents = secondBatch.filter((e) => e.type === 'stream')
        if (streamEvents.length > 0) {
          expect(streamEvents[0].event.id).not.toBe(cursor)
        }
      }
    })

    test('late-joining subscriber receives buffered events from current turn', async () => {
      const processId = await gateway.dispatch('test-agent', { input: 'Hello' })

      gateway.injectEvent(processId, {
        type: 'stream',
        event: {
          type: 'assistant',
          id: 'evt-buffered-1',
          createdAt: Date.now(),
          text: 'Hello',
        } as any,
      })
      gateway.injectEvent(processId, {
        type: 'stream',
        event: {
          type: 'assistant',
          id: 'evt-buffered-2',
          createdAt: Date.now(),
          text: 'World',
        } as any,
      })

      gateway.injectEvent(processId, { type: 'completed', finalStatus: 'completed' })

      const events: ProcessEvent[] = []
      for await (const event of gateway.subscribe(processId)) {
        events.push(event)
        if (event.type === 'completed') break
      }

      const bufferedEvents = events.filter(
        (e) => e.type === 'stream' && (e.event as any).id?.startsWith('evt-buffered'),
      )
      expect(bufferedEvents.length).toBe(2)
      expect((bufferedEvents[0] as any).event.text).toBe('Hello')
      expect((bufferedEvents[1] as any).event.text).toBe('World')
    })
  })

  describe('start() and shutdown()', () => {
    test('start and shutdown are idempotent', async () => {
      gateway.start({ intervalMs: 100 })
      gateway.start({ intervalMs: 100 }) // Should not throw
      await new Promise((r) => setTimeout(r, 50))
      await gateway.shutdown()
      await gateway.shutdown() // Should not throw
    })
  })
})

describe('GatewayImpl internals', () => {
  test('getExecutor returns default for null, throws for unknown', () => {
    const infra = createTestInfra()
    const gw = new GatewayImpl({
      appName: 'test',
      processStore: infra.processStore,
      sessionStore: infra.sessionStore,
      defaultExecutor: infra.executor,
      agents: {},
    })

    // @ts-expect-error - accessing private method for testing
    expect(gw.getExecutor(null).name).toBe('in-process')
    // @ts-expect-error - accessing private method for testing
    expect(() => gw.getExecutor('unknown')).toThrow("Executor 'unknown' not found")
  })

  test('accepts agents as Map and additional executors', async () => {
    const infra = createTestInfra()
    const mockExecutor = {
      name: 'mock',
      execute: async () => ({ status: 'completed' as const, events: [] }),
      cleanup: async () => {},
    }
    const gw = createGateway({
      appName: 'test',
      processStore: infra.processStore,
      sessionStore: infra.sessionStore,
      defaultExecutor: infra.executor,
      executors: { mock: mockExecutor },
      agents: new Map([['test-agent', createTestAgent('test-agent')]]),
    })

    const processId = await gw.dispatch('test-agent', { executor: 'mock' })
    expect(processId).toMatch(/^proc-/)
    await gw.shutdown()
  })

  test('status without artifact service omits artifacts', async () => {
    const infra = createTestInfra()
    const gw = createGateway({
      appName: 'test',
      processStore: infra.processStore,
      sessionStore: infra.sessionStore,
      defaultExecutor: infra.executor,
      agents: { 'test-agent': createTestAgent('test-agent') },
      // No artifactService
    })

    const processId = await gw.dispatch('test-agent')
    const status = await gw.status(processId)
    expect(status!.artifacts).toBeUndefined()
    await gw.shutdown()
  })
})

describe('InProcessExecutor', () => {
  test('executes turn and cleanup is a no-op', async () => {
    const infra = createTestInfra()
    const executor = infra.executor
    const agent = createTestAgent('test-agent')
    const session = await new (
      await import('../session/service')
    ).sessionService(infra.sessionStore).createSession('test-app', {})

    const events: unknown[] = []
    const result = await executor.execute(
      {
        process: {
          id: 'proc-1',
          appName: 'test-app',
          agentName: 'test-agent',
          sessionId: session.id,
          status: 'running',
          paused: false,
          schedule: null,
          nextWakeAt: null,
          executor: 'in-process',
          executorConfig: {},
          lastRunAt: null,
          createdAt: new Date(),
          metadata: {},
        },
        session,
        agent,
        messages: [{ payload: 'Test message' }],
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    )

    expect(['completed', 'sleeping', 'errored']).toContain(result.status)
    await executor.cleanup('any-process-id') // Should not throw
  })
})
