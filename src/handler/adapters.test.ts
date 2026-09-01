import type { CLIConfig } from '../cli/types'

import { agent } from '../agents'
import { adk } from '../api'
import { includeHistory } from '../context'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { MockAdapter } from '../testing'

/**
 * Adapters registered on the app (`adk({ adapters })`) are the documented seam for serving or
 * driving an agent without provider credentials. `app.run` honours them; these tests pin the same
 * guarantee for the handler entrypoints and for the runner `app.cli` builds.
 */

/** Remove every credential `getDefaultEndpoints()` would accept, so a real adapter must throw. */
function withoutOpenAICredentials(): void {
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('OPENAI_EU_API_KEY', '')
  vi.stubEnv('AZURE_OPENAI_ENDPOINT', '')
  vi.stubEnv('AZURE_OPENAI_API_KEY', '')
}

function scriptedApp(text: string) {
  const adapter = new MockAdapter({ responses: [{ text }] })
  const app = adk({ name: 'adapters-test', adapters: { openai: adapter } })
  const myAgent = agent({
    name: 'scripted',
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
  })
  return { adapter, app, myAgent }
}

describe('app adapters reach the handlers', () => {
  beforeEach(() => {
    withoutOpenAICredentials()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('app.handler.turn serves a turn with no API key configured', async () => {
    const { adapter, app, myAgent } = scriptedApp('Scripted turn reply')

    const handle = app.handler.turn({ agent: myAgent })
    const turnStream = handle({ input: { message: 'Hi' } })

    // The turn only runs while its stream is drained.
    const it = turnStream[Symbol.asyncIterator]()
    let iterResult = await it.next()
    while (!iterResult.done) iterResult = await it.next()
    const result = iterResult.value

    expect(result.status).toBe('completed')
    expect(result.output.text).toBe('Scripted turn reply')
    expect(adapter.stepCalls.length).toBe(1)
  })

  it('app.handler.rest serves a turn with no API key configured', async () => {
    const { adapter, app, myAgent } = scriptedApp('Scripted rest reply')

    const handle = app.handler.rest({ agent: myAgent })
    const response = await handle({ input: { message: 'Hi' } })

    expect(response.status).toBe('completed')
    expect(response.output.text).toBe('Scripted rest reply')
    expect(adapter.stepCalls.length).toBe(1)
  })

  it('handler-level adapters override the app adapters', async () => {
    const { app, myAgent } = scriptedApp('App adapter reply')
    const override = new MockAdapter({ responses: [{ text: 'Override reply' }] })

    const handle = app.handler.rest({ agent: myAgent, adapters: { openai: override } })
    const response = await handle({ input: { message: 'Hi' } })

    expect(response.output.text).toBe('Override reply')
    expect(override.stepCalls.length).toBe(1)
  })
})

describe('app adapters reach the CLI runner', () => {
  beforeEach(() => {
    withoutOpenAICredentials()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('app.cli builds a runner that resolves the app adapters', async () => {
    const { adapter, app, myAgent } = scriptedApp('Scripted cli reply')

    // `app.cli` cannot complete under Vitest: it lazily `require()`s `../cli`, and Node's require
    // cannot resolve the TypeScript sources. The runner is built before that load, so the runner it
    // hands the CLI is still observable on the config object we passed in.
    const cliConfig: CLIConfig = { input: 'Hi' }
    try {
      app.cli(myAgent, cliConfig)
    } catch {
      // Expected: the Ink/React CLI module is not loadable from source in this environment.
    }

    expect(cliConfig.runner).toBeDefined()

    const session = new BaseSession('adapters-test')
    session.input.message('Hi')
    const result = await cliConfig.runner!.run(myAgent, session)

    expect(result.status).toBe('completed')
    expect(result.output.text).toBe('Scripted cli reply')
    expect(adapter.stepCalls.length).toBe(1)
  })
})
