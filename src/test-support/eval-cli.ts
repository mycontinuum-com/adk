import { appendFileSync } from 'node:fs'

import { adk } from '../api/app'
import { openai } from '../providers/models'

const app = adk()
const text = app.evaluate.case({
  name: 'greeting/text',
  runnable: app.step({
    name: 'greeting',
    execute: (ctx) => {
      process.stdout.write('text diagnostic\n')
      if (process.env.EVAL_TEST_COUNTER) appendFileSync(process.env.EVAL_TEST_COUNTER, 'text\n')
      ctx.state.greeted = true
      ctx.note('Hello from the text case')
      return ctx.output('hello')
    },
  }),
  metrics: [{ name: 'greeting', evaluate: () => ({ passed: process.env.EVAL_TEST_FAIL !== '1' }) }],
})
const invalidVoiceAgent = app.agent({ name: 'invalid-voice', model: openai('unused'), context: [] })
const voice = app.evaluate.voice.case({
  name: 'greeting/voice',
  agent: invalidVoiceAgent,
  userAgent: invalidVoiceAgent,
})
const cases = process.env.EVAL_TEST_MIXED === '1' ? [text, voice] : [text]
void app.evaluate
  .cli(cases, {
    concurrency: 2,
    voice: { room: { url: 'ws://unused.invalid' } },
  })
  .then((code) => {
    process.exitCode = code
  })
