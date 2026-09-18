import { z } from 'zod'
import * as z3 from 'zod/v3'
import { z as z4Mini } from 'zod/v4-mini'

import { adk } from '../api/app'
import { safeParseToolArgs } from '../core/tools'
import { assertSupportedSchema, assertSupportedStateSchema } from './assert-zod-version'

it('accepts Zod 3 and Zod 4 Classic schemas at the boundary', () => {
  expect(() => assertSupportedSchema(z.number(), 'tool')).not.toThrow()
  expect(() => assertSupportedSchema(z3.number(), 'tool')).not.toThrow()
  expect(() =>
    assertSupportedStateSchema({ session: { legacy: z3.number(), modern: z.number() } }, 'app'),
  ).not.toThrow()
  expect(() => assertSupportedSchema({ safeParse() {} }, 'tool')).toThrow(/Zod 3 or Zod 4/)
  expect(() => assertSupportedSchema(z4Mini.number(), 'tool')).toThrow(/Zod 3 or Zod 4 Classic/)
})

it('builds a Zod 4 tool and validates coerced arguments', () => {
  const app = adk({ schema: { session: { count: z.number().default(0) } } })
  const tool = app.tool({
    name: 'count',
    description: 'Count',
    schema: z.object({ count: z.number().min(1) }),
    execute: (ctx) => ctx.args.count,
  })
  expect(safeParseToolArgs({ count: '5' }, tool.schema)).toEqual({
    success: true,
    data: { count: 5 },
  })
  expect(safeParseToolArgs({ count: '-1' }, tool.schema).success).toBe(false)
})

it('rejects Zod Mini at agent output boundaries', () => {
  const app = adk()
  expect(() =>
    app.agent({
      name: 'mini-output',
      model: { provider: 'openai', name: 'test' },
      context: [],
      output: { schema: z4Mini.object({ value: z4Mini.number() }) } as never,
    }),
  ).toThrow(/app\.agent.*Zod 3 or Zod 4 Classic/)
})

it('builds a Zod 3 tool and preserves its transforms and refinements', () => {
  const app = adk()
  const tool = app.tool({
    name: 'legacy-count',
    description: 'Count',
    schema: z3.object({ count: z3.string().regex(/^\d+$/).transform(Number) }),
    execute: (ctx) => ctx.args.count,
  })
  expect(safeParseToolArgs({ count: '5' }, tool.schema)).toEqual({
    success: true,
    data: { count: 5 },
  })
  expect(safeParseToolArgs({ count: 'nope' }, tool.schema).success).toBe(false)
})
