import { expectTypeOf } from 'vitest'
import { z } from 'zod'

import type { VoiceEvalResult } from './types'

import { adk } from '../../api/app'
import { openai } from '../../providers/models'

const schema = { session: { lookups: z.number().default(0) } }
const app = adk({ schema })
const agent = app.agent({ name: 'voice', model: openai.live('gpt-live-1'), context: [] })
const backend = app.agent({
  name: 'backend',
  model: openai('gpt-5.4-mini'),
  context: [],
  output: { schema: z.object({ message: z.string() }) },
})
const userAgent = app.agent({ name: 'caller', model: openai.realtime('gpt-realtime'), context: [] })

expectTypeOf(
  app.evaluate.voice({
    name: 'live',
    agent,
    backend,
    userAgent,
    durationMs: 1_000,
    hooks: [
      {
        onResult(ctx) {
          expectTypeOf(ctx.state.lookups).toEqualTypeOf<number>()
          expectTypeOf(ctx.backendSession.state.lookups).toEqualTypeOf<number>()
          expectTypeOf(ctx.output).toEqualTypeOf<{ message: string }>()
          ctx.voice.appendCommentary(ctx.output.message)
          // @ts-expect-error The hook receives the backend's inferred output.
          void ctx.output.missing
          // @ts-expect-error Live controls do not expose Realtime generation.
          ctx.voice.generateReply()
        },
      },
    ],
  }),
).toEqualTypeOf<Promise<VoiceEvalResult<typeof schema>>>()

app.evaluate.voice({ name: 'realtime', agent: userAgent, userAgent })

const typedCase = app.evaluate.voice.case({
  name: 'typed-case',
  agent,
  backend,
  userAgent,
  hooks: [
    {
      onResult(ctx) {
        expectTypeOf(ctx.output).toEqualTypeOf<{ message: string }>()
        // @ts-expect-error The case helper preserves the backend output shape.
        void ctx.output.missing
      },
    },
  ],
})
const factoryCase = app.evaluate.voice.case<{ message: string }>((control) => ({
  name: 'factory-case',
  agent,
  backend,
  userAgent,
  hooks: [
    {
      onResult(ctx) {
        expectTypeOf(ctx.output).toEqualTypeOf<{ message: string }>()
        // @ts-expect-error A factory does not erase output typing.
        void ctx.output.missing
        void control.disconnectUser()
      },
    },
  ],
}))
app.evaluate.voice([typedCase, factoryCase, { name: 'realtime', agent: userAgent, userAgent }])

// @ts-expect-error A Live eval requires a backend.
app.evaluate.voice({ name: 'missing-backend', agent, userAgent })

// @ts-expect-error A Live frontend is not an executable text backend.
app.evaluate.voice({ name: 'live-backend', agent, backend: agent, userAgent })

// @ts-expect-error A Live frontend cannot currently simulate the caller.
app.evaluate.voice({ name: 'live-caller', agent, backend, userAgent: agent })
