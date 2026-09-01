/**
 * ArtifactService compliance test suite.
 *
 * All ArtifactService implementations must pass these tests. Run against new backends with:
 * runArtifactServiceTests('MyStore', () => new MyStore())
 */

import type { ArtifactService } from './types'

import { InMemoryArtifactService } from './memory'

export function runArtifactServiceTests(
  name: string,
  createService: () => ArtifactService,
  cleanup?: () => void | Promise<void>,
) {
  describe(`${name} — ArtifactService compliance`, () => {
    let service: ArtifactService

    beforeEach(() => {
      service = createService()
    })

    afterEach(async () => {
      await service.close()
      await cleanup?.()
    })

    describe('save and load', () => {
      test('string artifact round-trips', async () => {
        const result = await service.save('app', 'proc1', 'plan', 'My plan')
        expect(result.version).toBe(0)

        const loaded = await service.load('app', 'proc1', 'plan')
        expect(loaded!.data).toBe('My plan')
        expect(loaded!.version).toBe(0)
      })

      test('binary artifact round-trips', async () => {
        const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
        await service.save('app', 'proc1', 'image', binary, { mimeType: 'image/png' })

        const loaded = await service.load('app', 'proc1', 'image')
        expect(Buffer.isBuffer(loaded!.data)).toBe(true)
        expect(loaded!.data).toEqual(binary)
        expect(loaded!.mimeType).toBe('image/png')
      })

      test('returns null for non-existent', async () => {
        expect(await service.load('app', 'proc1', 'missing')).toBeNull()
        expect(await service.load('app', 'proc1', 'plan', { version: 999 })).toBeNull()
      })

      test('stores metadata and createdAt', async () => {
        const before = Date.now()
        await service.save('app', 'proc1', 'plan', 'content', {
          metadata: { status: 'draft' },
        })

        const loaded = await service.load('app', 'proc1', 'plan')
        expect(loaded!.metadata).toEqual({ status: 'draft' })
        expect(loaded!.createdAt.getTime()).toBeGreaterThanOrEqual(before)
      })
    })

    describe('versioning', () => {
      test('increments version and preserves history', async () => {
        expect((await service.save('app', 'proc1', 'plan', 'v0')).version).toBe(0)
        expect((await service.save('app', 'proc1', 'plan', 'v1')).version).toBe(1)
        expect((await service.save('app', 'proc1', 'plan', 'v2')).version).toBe(2)

        // Latest
        expect((await service.load('app', 'proc1', 'plan'))!.data).toBe('v2')
        // Specific version
        expect((await service.load('app', 'proc1', 'plan', { version: 0 }))!.data).toBe('v0')
      })

      test('listVersions returns all versions descending', async () => {
        await service.save('app', 'proc1', 'plan', 'v0')
        await service.save('app', 'proc1', 'plan', 'v1')

        const versions = await service.listVersions('app', 'proc1', 'plan')
        expect(versions.map((v) => v.version)).toEqual([1, 0])
        expect(await service.listVersions('app', 'proc1', 'missing')).toEqual([])
      })
    })

    describe('MIME type inference', () => {
      test('infers types correctly', async () => {
        expect((await service.save('app', 'p', 'a', '{"x":1}')).mimeType).toBe('application/json')
        expect((await service.save('app', 'p', 'b', '[1,2]')).mimeType).toBe('application/json')
        expect((await service.save('app', 'p', 'c', '# H1')).mimeType).toBe('text/markdown')
        expect((await service.save('app', 'p', 'd', 'plain')).mimeType).toBe('text/plain')
        expect((await service.save('app', 'p', 'e', Buffer.from([1]))).mimeType).toBe(
          'application/octet-stream',
        )
      })

      test('explicit mimeType overrides', async () => {
        const result = await service.save('app', 'p', 'f', '# MD', { mimeType: 'text/plain' })
        expect(result.mimeType).toBe('text/plain')
      })
    })

    describe('namespace isolation', () => {
      test('isolated by appName and processId', async () => {
        await service.save('app1', 'proc1', 'x', 'a1p1')
        await service.save('app2', 'proc1', 'x', 'a2p1')
        await service.save('app1', 'proc2', 'x', 'a1p2')

        expect((await service.load('app1', 'proc1', 'x'))!.data).toBe('a1p1')
        expect((await service.load('app2', 'proc1', 'x'))!.data).toBe('a2p1')
        expect((await service.load('app1', 'proc2', 'x'))!.data).toBe('a1p2')
      })

      test('list scoped to process', async () => {
        await service.save('app', 'proc1', 'a', 'x')
        await service.save('app', 'proc1', 'b', 'x')
        await service.save('app', 'proc2', 'c', 'x')

        expect((await service.list('app', 'proc1')).map((a) => a.name).toSorted()).toEqual([
          'a',
          'b',
        ])
        expect(await service.list('app', 'empty')).toEqual([])
      })
    })

    describe('delete', () => {
      test('removes artifact and versions', async () => {
        await service.save('app', 'proc1', 'plan', 'v0')
        await service.save('app', 'proc1', 'plan', 'v1')
        await service.save('app', 'proc1', 'other', 'x')

        await service.delete('app', 'proc1', 'plan')

        expect(await service.load('app', 'proc1', 'plan')).toBeNull()
        expect(await service.listVersions('app', 'proc1', 'plan')).toEqual([])
        expect((await service.load('app', 'proc1', 'other'))!.data).toBe('x')
      })

      test('no-op for non-existent', async () => {
        await expect(service.delete('app', 'proc1', 'missing')).resolves.toBeUndefined()
      })
    })

    describe('mutation isolation', () => {
      test('clones on save and load', async () => {
        const metadata = { nested: { x: 1 } }
        const buffer = Buffer.from([1, 2, 3])

        await service.save('app', 'proc1', 'a', 'x', { metadata })
        await service.save('app', 'proc1', 'b', buffer)

        // Mutate inputs
        metadata.nested.x = 999
        buffer[0] = 99

        // Verify store unaffected
        expect((await service.load('app', 'proc1', 'a'))!.metadata).toEqual({ nested: { x: 1 } })
        expect((await service.load('app', 'proc1', 'b'))!.data).toEqual(Buffer.from([1, 2, 3]))

        // Verify load returns clone
        const loaded = await service.load('app', 'proc1', 'a')
        ;(loaded!.metadata as any).nested.x = 888
        expect((await service.load('app', 'proc1', 'a'))!.metadata).toEqual({ nested: { x: 1 } })
      })
    })

    describe('list metadata', () => {
      test('returns correct summaries', async () => {
        await service.save('app', 'proc1', 'plan', '# Plan')
        await service.save('app', 'proc1', 'plan', '# Updated') // v1

        const list = await service.list('app', 'proc1')
        expect(list[0].name).toBe('plan')
        expect(list[0].latestVersion).toBe(1)
        expect(list[0].mimeType).toBe('text/markdown')
      })
    })
  })
}

runArtifactServiceTests('InMemoryArtifactService', () => new InMemoryArtifactService())
