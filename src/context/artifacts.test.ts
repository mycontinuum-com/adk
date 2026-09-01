/**
 * Tests for ctx.artifacts proxy — only proxy-specific behavior. ArtifactService behavior is tested
 * in compliance.test.ts.
 */

import { describe, test, expect, beforeEach } from 'vitest'

import type { ArtifactUpdateEvent } from '../types/events'

import { InMemoryArtifactService } from '../artifacts/memory'
import { createArtifactsProxy, createNoopArtifactsProxy } from './artifacts'

describe('createArtifactsProxy', () => {
  let service: InMemoryArtifactService
  let events: ArtifactUpdateEvent[]
  let proxy: ReturnType<typeof createArtifactsProxy>

  beforeEach(() => {
    service = new InMemoryArtifactService()
    events = []
    proxy = createArtifactsProxy({
      service,
      appName: 'test-app',
      processId: 'proc-1',
      emitEvent: (event) => events.push(event),
    })
  })

  test('emits artifact_update event on save', async () => {
    await proxy.save('plan', '# Plan')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'artifact_update',
      name: 'plan',
      version: 0,
      mimeType: 'text/markdown',
      processId: 'proc-1',
    })
  })

  test('caches after save, returns from cache on read', async () => {
    await proxy.save('plan', 'content')
    expect(proxy.plan).toBe('content') // Sync read from cache
  })

  test('caches after load', async () => {
    await service.save('test-app', 'proc-1', 'plan', 'v0')
    await proxy.load('plan')
    expect(proxy.plan).toBe('v0')
  })

  test('deserializes JSON on load', async () => {
    await service.save('test-app', 'proc-1', 'data', '{"key":"value"}', {
      mimeType: 'application/json',
    })
    expect(await proxy.load('data')).toEqual({ key: 'value' })
  })

  test('serializes objects to JSON on save', async () => {
    await proxy.save('data', { key: 'value' })
    const artifact = await service.load('test-app', 'proc-1', 'data')
    expect(artifact!.mimeType).toBe('application/json')
  })

  test('property write saves artifact', async () => {
    proxy.plan = 'My plan'
    await new Promise((r) => setTimeout(r, 10))

    expect(await service.load('test-app', 'proc-1', 'plan')).not.toBeNull()
    expect(events).toHaveLength(1)
  })

  test('cannot overwrite methods', () => {
    expect(() => {
      ;(proxy as any).save = 'x'
    }).toThrow()
    expect(() => {
      ;(proxy as any).load = 'x'
    }).toThrow()
    expect(() => {
      ;(proxy as any).list = 'x'
    }).toThrow()
  })

  test('uncached property returns undefined', () => {
    expect(proxy.missing).toBeUndefined()
  })

  test('handles binary data round-trip', async () => {
    const buffer = Buffer.from([1, 2, 3])
    await proxy.save('binary', buffer, { mimeType: 'application/octet-stream' })
    const loaded = await proxy.load('binary')
    expect(Buffer.isBuffer(loaded)).toBe(true)
  })

  test('handles invalid JSON gracefully', async () => {
    await service.save('test-app', 'proc-1', 'bad', 'not valid json', {
      mimeType: 'application/json',
    })
    expect(await proxy.load('bad')).toBe('not valid json')
  })
})

describe('createNoopArtifactsProxy', () => {
  test('all operations are no-ops', async () => {
    const proxy = createNoopArtifactsProxy()

    expect(await proxy.save('x', 'y')).toBe(-1)
    expect(await proxy.load('x')).toBeUndefined()
    expect(await proxy.list()).toEqual([])
    expect(proxy.missing).toBeUndefined()
    expect(() => {
      proxy.x = 'y'
    }).not.toThrow()
  })
})
