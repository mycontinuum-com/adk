import { expectTypeOf } from 'vitest'
import { z } from 'zod'

import type { ModelConfig } from '../types/runnables'
import type { VoiceHandlerHandle } from '../voice/types'

import { adk } from '../api/app'
import { openai } from '../integrations/openai'

const app = adk({ schema: { session: { request: z.string().default('') } } })
const backend = app.agent({
  name: 'backend',
  model: openai('gpt-5.4-mini'),
  context: [],
  output: { schema: z.object({ message: z.string() }) },
})
const model = openai.live('gpt-live-1', { voice: 'marin' })
const agent = app.agent({
  name: 'voice',
  model,
  context: [app.context.system('A synthetic voice demo.')],
})

expectTypeOf(model).not.toMatchTypeOf<ModelConfig>()
expectTypeOf(
  app.handler.voice({
    agent,
    backend,
    hooks: [
      {
        onEnter(ctx) {
          expectTypeOf(ctx.state.request).toEqualTypeOf<string>()
          expectTypeOf(ctx.session.id).toEqualTypeOf<string>()
          ctx.voice.appendThinking('The practice is fictional.')
          // @ts-expect-error Live uses append controls rather than generation turns.
          ctx.voice.generateReply()
        },
        onResult(ctx) {
          expectTypeOf(ctx.output.message).toEqualTypeOf<string>()
          expectTypeOf(ctx.state.request).toEqualTypeOf<string>()
          expectTypeOf(ctx.delegation.id).toEqualTypeOf<string>()
          expectTypeOf(ctx.backendSession.state.request).toEqualTypeOf<string>()
          ctx.voice.appendCommentary(ctx.output.message)
        },
      },
    ],
  }),
).toEqualTypeOf<VoiceHandlerHandle>()

// @ts-expect-error Client delegation requires a backend.
app.handler.voice({ agent })

// @ts-expect-error Live agents require the voice handler, not the text runner.
app.run(agent, 'hello')

// @ts-expect-error A Live agent cannot be its own text backend.
app.handler.voice({ agent, backend: agent })

// @ts-expect-error Live agents delegate tool work to their backend.
app.agent({ name: 'invalid', model, context: [], tools: [] })

// @ts-expect-error Live configuration belongs on the agent.
app.handler.voice({ model, instructions: 'Retired API.', backend })

app.handler.voice({ agent: backend })
