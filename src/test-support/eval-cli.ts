import { appendFileSync } from 'node:fs'
import { z } from 'zod'

import type { ModelAdapter } from '../types/runnables'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'
import {
  CONCURRENCY,
  COUNTED,
  GREETING,
  LOOKER,
  LOOKUP,
  OLD_LINE,
  TOOL,
  VOICE,
} from './eval-cli-suite'
import { VECTOR_PATHS } from './scorecard-repository'

/** A model that looks the line up once, then answers: the same on every run, at any concurrency. */
class LookupModel extends MockAdapter {
  override async *step(...args: Parameters<ModelAdapter['step']>) {
    const lookedUp = args[0].events.some((event) => event.type === 'tool_result')
    this.setResponses([lookedUp ? { text: 'Done' } : { toolCalls: [{ name: TOOL, args: {} }] }])
    return yield* super.step(...args)
  }
}

const app = adk({
  schema: {
    session: { greeted: z.boolean().default(false), lookedUp: z.boolean().default(false) },
  },
  adapters: { openai: new LookupModel() },
})
const text = app.evaluate.case({
  name: GREETING,
  runnable: app.step({
    name: 'greeting',
    execute: (ctx) => {
      process.stdout.write('text diagnostic\n')
      if (process.env.EVAL_TEST_COUNTER) appendFileSync(process.env.EVAL_TEST_COUNTER, COUNTED)
      ctx.state.greeted = true
      ctx.note('Hello from the text case')
      return ctx.output('hello')
    },
  }),
  metrics: [{ name: 'greeting', evaluate: () => ({ passed: process.env.EVAL_TEST_FAIL !== '1' }) }],
})
const invalidVoiceAgent = app.agent({ name: 'invalid-voice', model: openai('unused'), context: [] })
const voice = app.evaluate.voice.case({
  name: VOICE,
  agent: invalidVoiceAgent,
  userAgent: invalidVoiceAgent,
})
const lookup = app.evaluate.case({
  name: LOOKUP,
  runnable: app.agent({
    name: LOOKER.agent,
    model: openai(LOOKER.model, { reasoning: { effort: LOOKER.effort } }),
    context: [
      app.context.system('Look the line up.'),
      app.context.system((ctx) => `Lines looked up so far: ${ctx.state.lookedUp ? 1 : 0}`),
      app.context.history(),
    ],
    tools: [
      app.tool({
        name: TOOL,
        description: 'Looks the line up.',
        schema: z.object({}),
        execute: (ctx) => {
          ctx.state.lookedUp = true
          return { line: process.env.EVAL_TEST_LINE ?? OLD_LINE }
        },
      }),
    ],
  }),
  input: { message: 'What is the line?' },
})
const cases =
  process.env.EVAL_TEST_MIXED === '1'
    ? [text, voice]
    : process.env.EVAL_TEST_AGENT === '1'
      ? [text, lookup]
      : [text]
const scorecard = process.env.EVAL_TEST_SCORECARD
void app.evaluate
  .cli(cases, {
    concurrency: CONCURRENCY,
    stopOnFirstFailure: process.env.EVAL_TEST_STOP === '1',
    voice: { room: { url: 'ws://unused.invalid' } },
    ...(scorecard && {
      scorecard: {
        path: scorecard,
        fingerprint: process.env.EVAL_TEST_FINGERPRINT?.split(',') ?? VECTOR_PATHS,
      },
    }),
  })
  .then((code) => {
    process.exitCode = code
  })
