import { z as z3 } from 'zod/v3'
import { z as z4 } from 'zod/v4'

import { zodToToolSchema } from '../providers/zodToJsonSchema'
import { adk } from './app'

it('applies defaults from both generations without composing their schemas', async () => {
  const app = adk({
    schema: {
      session: {
        legacy: z3.number().default(3),
        modern: z4.string().default('four'),
      },
    },
  })
  const result = await app.run(
    app.step({
      name: 'read',
      execute: (ctx) => {
        expect(ctx.state.legacy).toBe(3)
        expect(ctx.state.modern).toBe('four')
      },
    }),
    { input: { state: {} } },
  )
  expect(result.status).toBe('completed')
})

it('validates foreign-generation yield schemas in the generated root schema', () => {
  const app = adk()
  let transformCount = 0
  app.tool({
    name: 'legacy',
    description: 'Legacy approval',
    schema: z3.object({}),
    yieldSchema: z3.object({
      count: z3
        .string()
        .regex(/^\d+$/)
        .transform((value) => {
          transformCount += 1
          return Number(value)
        }),
    }),
  })
  app.tool({
    name: 'modern',
    description: 'Modern approval',
    schema: z4.object({}),
    yieldSchema: z4.object({ enabled: z4.boolean() }),
  })

  const generated = app.toolInputsSchema()
  const embedded = z4.object({ approvals: generated })
  expect(
    embedded.parse({
      approvals: [
        { callId: 'one', toolName: 'legacy', input: { count: '7' } },
        { callId: 'two', toolName: 'modern', input: { enabled: true } },
      ],
    }),
  ).toEqual({
    approvals: [
      { callId: 'one', toolName: 'legacy', input: { count: 7 } },
      { callId: 'two', toolName: 'modern', input: { enabled: true } },
    ],
  })
  expect(transformCount).toBe(1)

  const rejected = generated.safeParse([
    { callId: 'one', toolName: 'legacy', input: { count: 'nope' } },
  ])
  expect(rejected.success).toBe(false)
  if (!rejected.success) expect(rejected.error.issues[0]?.path).toEqual([0, 'input', 'count'])

  expect(zodToToolSchema('approvals', '', embedded).parameters).toMatchObject({
    properties: {
      approvals: {
        items: {
          anyOf: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                input: expect.objectContaining({
                  properties: expect.objectContaining({
                    count: { type: 'string', pattern: '^\\d+$' },
                  }),
                }),
              }),
            }),
          ]),
        },
      },
    },
  })
})
