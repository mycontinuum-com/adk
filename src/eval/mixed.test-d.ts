import { expectTypeOf } from 'vitest'
import { z } from 'zod'

import type { EvalResult, MixedEvalResult } from './types'

import { adk } from '../api/app'
import { openai } from '../providers/models'

const schema = { session: { greeting: z.string() } }
const app = adk({ schema })
const agent = app.agent({ name: 'voice', model: openai('unused'), context: [] })
const text = app.evaluate.case({
  name: 'text',
  runnable: app.step({ name: 'greeting', execute: (ctx) => ctx.output('hello') }),
})
const voice = app.evaluate.voice.case({ name: 'voice', agent, userAgent: agent })
const cases = app.evaluate.cases([text, voice])

expectTypeOf(app.evaluate([text])).toEqualTypeOf<Promise<EvalResult<typeof schema>>>()
expectTypeOf(app.evaluate(cases)).toEqualTypeOf<Promise<MixedEvalResult<typeof schema>>>()
expectTypeOf(app.evaluate.cli(cases)).toEqualTypeOf<Promise<0 | 1 | 2>>()

void app.evaluate(cases, {
  voice: {
    metrics: [{ name: 'transcript', evaluate: (run) => ({ passed: run.transcript.length > 0 }) }],
  },
  metrics: [
    {
      name: 'state',
      evaluate: (run) => ({ passed: run.session.state.greeting === 'hello' }),
    },
  ],
})

// @ts-expect-error Voice room configuration belongs in voice, not at the shared suite level.
void app.evaluate(cases, {
  room: { url: 'ws://unused' },
})

// @ts-expect-error A mixed callback cannot assume every result has text-only events.
void app.evaluate(cases, {
  onCase: (result: import('./types').EvalCaseResult<typeof schema>) => {
    void result.events
  },
})

const backend = app.agent({
  name: 'backend',
  model: openai('unused'),
  output: { schema: z.object({ message: z.string() }) },
  context: [],
})
const live = app.evaluate.voice.case({
  name: 'live',
  agent: app.agent({ name: 'live', model: openai.live('gpt-live-1'), context: [] }),
  backend,
  userAgent: agent,
  hooks: [{ onResult: (ctx) => ctx.voice.appendCommentary(ctx.output.message) }],
})
const allCases = app.evaluate.cases([text, voice, live])
expectTypeOf(app.evaluate(allCases)).toEqualTypeOf<Promise<MixedEvalResult<typeof schema>>>()
expectTypeOf(app.evaluate.cli(allCases)).toEqualTypeOf<Promise<0 | 1 | 2>>()

const judge = app.evaluate.judge({ name: 'consent', criteria: { asks: 'Asks to send it.' } })
void app.evaluate.case({ name: 'judged-text', runnable: text.runnable, metrics: [judge] })
void app.evaluate.voice.case({ name: 'judged-voice', agent, userAgent: agent, metrics: [judge] })
void app.evaluate(allCases, { metrics: [judge], voice: { metrics: [judge] } })
