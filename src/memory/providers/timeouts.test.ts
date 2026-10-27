import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQdrantIndex, qdrant } from './qdrant'
import { createVoyageEmbedder, voyage } from './voyage'

const TIMEOUT_MS = 200
const retry = { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10, backoffMultiplier: 1 }
const VOYAGE_TIMEOUT = new Error(`Voyage request timed out after ${TIMEOUT_MS}ms`)
const VOYAGE_REQUEST = 'POST /v1/embeddings'
const QDRANT_RETRIEVE = 'POST /collections/entity-memory/points'
const INPUT = ['a request to remember']

type Answer = (req: IncomingMessage, res: ServerResponse) => void

const neverAnswer: Answer = () => {}

const stallAfterHeaders: Answer = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.write('{"result":[')
}

const unavailable: Answer = (_req, res) => {
  res.writeHead(503, { 'content-type': 'application/json' })
  res.end('{"detail":"Service Unavailable"}')
}

let server: Server | undefined

async function listen(answer: Answer): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = []
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    answer(req, res)
  })
  const open = server
  await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve))
  const address = open.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an IP address for the test server')
  }
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

async function voyageServedBy(answer: Answer): Promise<string[]> {
  const { url, requests } = await listen(answer)
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    realFetch(String(input).replace('https://api.voyageai.com', url), init),
  )
  return requests
}

async function qdrantUpsertServedBy(answer: Answer) {
  const { url, requests } = await listen(answer)
  const index = createQdrantIndex(qdrant({ url, timeoutMs: TIMEOUT_MS, retry }))
  const outcome = await settled(
    index.upsert('entity-memory', [{ id: 'req-1', embedding: [0.1, 0.2] }], {
      variant: 'created',
    }),
  )
  return { ...outcome, posts: requests.filter((r) => r.startsWith('POST')) }
}

async function settled(work: Promise<unknown>): Promise<{ error: unknown }> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  )
  return { error }
}

function embedder(timeoutMs?: number) {
  return createVoyageEmbedder(
    voyage('voyage-4-large', { dimensions: 2048, apiKey: 'test-key', timeoutMs, retry }),
  )
}

describe('memory provider requests to a degraded dependency', () => {
  beforeEach(() => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      vi.stubEnv(name, '')
    }
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (!server) return
    const open = server
    server = undefined
    open.closeAllConnections()
    await new Promise((resolve) => open.close(resolve))
  })

  it('fails a Qdrant upsert after each attempt times out', { timeout: 10_000 }, async () => {
    const { error, posts } = await qdrantUpsertServedBy(neverAnswer)

    expect(error).toBeInstanceOf(Error)
    expect(posts).toEqual([QDRANT_RETRIEVE, QDRANT_RETRIEVE])
  })

  it('fails a Qdrant upsert whose body stalls after the headers', { timeout: 10_000 }, async () => {
    const { error, posts } = await qdrantUpsertServedBy(stallAfterHeaders)

    expect(error).toBeInstanceOf(Error)
    expect(posts).toEqual([QDRANT_RETRIEVE, QDRANT_RETRIEVE])
  })

  it('fails a Voyage embed after each attempt times out', { timeout: 10_000 }, async () => {
    const requests = await voyageServedBy(neverAnswer)

    const { error } = await settled(embedder(TIMEOUT_MS).embed(INPUT))

    expect(error).toEqual(VOYAGE_TIMEOUT)
    expect(requests).toEqual([VOYAGE_REQUEST, VOYAGE_REQUEST])
  })

  it('fails a Voyage embed whose body stalls after the headers', { timeout: 10_000 }, async () => {
    const requests = await voyageServedBy(stallAfterHeaders)

    const { error } = await settled(embedder(TIMEOUT_MS).embed(INPUT))

    expect(error).toEqual(VOYAGE_TIMEOUT)
    expect(requests).toEqual([VOYAGE_REQUEST, VOYAGE_REQUEST])
  })

  it('makes one request per attempt while Voyage answers 503', { timeout: 10_000 }, async () => {
    const requests = await voyageServedBy(unavailable)

    const { error } = await settled(embedder().embed(INPUT))

    expect(String(error)).toContain('503')
    expect(requests).toEqual([VOYAGE_REQUEST, VOYAGE_REQUEST])
  })

  it('refuses to create a provider with an invalid timeout', () => {
    expect(() => embedder(0)).toThrow(RangeError)
    expect(() => createQdrantIndex(qdrant({ url: 'http://127.0.0.1:1', timeoutMs: 0 }))).toThrow(
      RangeError,
    )
  })
})
