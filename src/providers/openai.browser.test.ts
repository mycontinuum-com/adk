/**
 * Providers.openai-browser — A Reader-Supplied Key Can Drive The Adapter In A Browser
 *
 * The docs site's live cells construct an OpenAIAdapter in a page with a key the reader pasted.
 * That needs three things the server path never exercised: `OpenAIAdapter` importable from the
 * /openai subpath, endpoint injection that never touches process.env, and the OpenAI client's
 * browser guard opted out via the endpoint's `dangerouslyAllowBrowser`. The guard exists to stop
 * servers embedding keys in shipped pages; a reader typing their own key into their own browser is
 * the guard's intended exception.
 *
 * Evidence: behavior/build
 */
import { afterEach, describe, expect, it } from 'vitest'

import { OpenAIAdapter } from '../integrations/openai'

// The SDK's guard sniffs `window.document` and `window.navigator`, so the window stub must carry
// both — separate bare globals do not trip it.
const fakeDocument = { createElement: () => ({}) }
const fakeNavigator = { userAgent: 'test-browser' }
const BROWSER_GLOBALS: Record<string, unknown> = {
  window: { document: fakeDocument, navigator: fakeNavigator },
  document: fakeDocument,
  navigator: fakeNavigator,
}

function enterFakeBrowser(): void {
  for (const [key, value] of Object.entries(BROWSER_GLOBALS)) {
    ;(globalThis as Record<string, unknown>)[key] = value
  }
}

function leaveFakeBrowser(): void {
  for (const key of Object.keys(BROWSER_GLOBALS)) {
    delete (globalThis as Record<string, unknown>)[key]
  }
}

describe('providers.openai-browser', () => {
  afterEach(() => {
    leaveFakeBrowser()
  })

  it('OpenAIAdapter is importable from the /openai subpath entry', () => {
    expect(typeof OpenAIAdapter).toBe('function')
  })

  it('without the opt-in, the client refuses to construct in a browser', () => {
    enterFakeBrowser()
    const adapter = new OpenAIAdapter([{ type: 'openai', apiKey: 'reader-key' }])
    expect(() =>
      (adapter as any).createClient({ type: 'openai', apiKey: 'reader-key' }, 'gpt-4o-mini'),
    ).toThrow(/browser/i)
  })

  it('dangerouslyAllowBrowser on the endpoint constructs the client in a browser', () => {
    enterFakeBrowser()
    const endpoint = {
      type: 'openai' as const,
      apiKey: 'reader-key',
      dangerouslyAllowBrowser: true,
    }
    const adapter = new OpenAIAdapter([endpoint])
    const client = (adapter as any).createClient(endpoint, 'gpt-4o-mini')
    expect(client.apiKey).toBe('reader-key')
  })

  it('an azure endpoint passes the opt-in through as well', () => {
    enterFakeBrowser()
    const endpoint = {
      type: 'azure' as const,
      baseUrl: 'https://example.invalid',
      apiVersion: '2025-01-01-preview',
      apiKey: 'reader-key',
      dangerouslyAllowBrowser: true,
    }
    const adapter = new OpenAIAdapter([endpoint])
    const client = (adapter as any).createClient(endpoint, 'gpt-4o-mini')
    expect(client.apiKey).toBe('reader-key')
  })
})
