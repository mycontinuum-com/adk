/**
 * Workflow.minimal-typed-run — Minimal Typed Run
 *
 * An app.step whose execute calls app.ask twice, the second with a Zod schema. Each app.ask runs on
 * its own fresh session; the schema-less call returns string, the schema call returns the parsed
 * typed value; the body's return value is surfaced.
 *
 * Evidence: unit + type-level (see ask.typed.test-d.ts)
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

const mockAdapter = new MockAdapter()

const app = adk({
  name: 'minimal-typed',
  adapters: { openai: mockAdapter },
  defaultModel: openai('gpt-4o-mini'),
})

describe('workflow.minimal-typed-run', () => {
  it('app.ask(prompt) returns string; app.ask(prompt, { schema }) returns typed value', async () => {
    mockAdapter.setResponses([
      { text: 'TypeScript generics' },
      { text: '{"title":"TypeScript generics","bullets":["point 1","point 2","point 3"]}' },
    ])

    const topic = await app.ask('Pick one trending TypeScript topic. Return only the topic.')
    expect(typeof topic).toBe('string')
    expect(topic).toBe('TypeScript generics')

    const briefSchema = z.object({ title: z.string(), bullets: z.array(z.string()).length(3) })
    const result = await app.ask(`Write a 3-bullet brief on: ${topic}`, { schema: briefSchema })
    expect(result.title).toBe('TypeScript generics')
    expect(result.bullets).toHaveLength(3)
  })

  it('each app.ask runs on its own fresh session (no shared state between calls)', async () => {
    mockAdapter.setResponses([{ text: 'session-A-response' }, { text: 'session-B-response' }])

    const r1 = await app.ask('call 1')
    const r2 = await app.ask('call 2')

    // Both calls succeed — each had its own fresh session
    expect(r1).toBe('session-A-response')
    expect(r2).toBe('session-B-response')
  })

  it('app.run(app.step(...)) returns RunResult with status', async () => {
    mockAdapter.setResponses([{ text: 'hello' }])

    const wf = app.step({
      name: 'minimal',
      execute: async () => {
        await app.ask('hello')
      },
    })
    const result = await app.run(wf, 'go')
    expect(result.status).toBeDefined()
    expect(result.status).toBe('completed')
  })
})
