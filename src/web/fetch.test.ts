import { vi } from 'vitest'

import { fetchPage } from './fetch'

// Stands in for what Node throws when the optional HTML-extraction peers were never installed.
vi.mock('jsdom', () => {
  const error: NodeJS.ErrnoException = new Error(
    "Cannot find package 'jsdom' imported from /app/node_modules/@animahealth/adk/dist/web/index.js",
  )
  error.code = 'ERR_MODULE_NOT_FOUND'
  throw error
})

function htmlResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: () => Promise.resolve(html),
  } as unknown as Response
}

describe('fetchPage without the HTML-extraction peers', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    global.fetch = vi
      .fn<(...args: unknown[]) => unknown>()
      .mockResolvedValue(
        htmlResponse('<html><head><title>Doc</title></head><body><p>Body</p></body></html>'),
      ) as unknown as typeof fetch
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // Reported as `network_error`, this reads to a model as a broken page and it retries forever.
  test('reports a missing dependency rather than a network failure', async () => {
    const result = await fetchPage('https://example.com/article')

    expect(result.success).toBe(false)
    expect(result.error).toBe('missing_dependency')
    expect(result.errorMessage).toBe(
      'HTML extraction dependencies not found. Install them with: npm install jsdom @mozilla/readability turndown',
    )
  })

  test('a genuine network failure still reports network_error', async () => {
    global.fetch = vi
      .fn<(...args: unknown[]) => unknown>()
      .mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch

    const result = await fetchPage('https://example.com/article')

    expect(result.success).toBe(false)
    expect(result.error).toBe('network_error')
  })
})
