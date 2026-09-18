import { z } from 'zod'

import { safeParseToolArgs } from '../core/tools'
import { createParser } from './parser'

for (const [name, tag] of Object.entries({
  default: z.literal('a').default('a'),
  optional: z.literal('a').optional(),
  nullable: z.literal('a').nullable(),
  readonly: z.literal('a').readonly(),
  enum: z.enum(['a', 'b']).optional(),
})) {
  it(`parses and coerces a ${name} discriminator`, () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: tag, count: z.number() }),
      z.object({ kind: z.literal('other'), name: z.string() }),
    ])
    expect(createParser(schema).parse('{"kind":"a","count":5}')).toMatchObject({
      success: true,
      value: { kind: 'a', count: 5 },
    })
    expect(safeParseToolArgs({ kind: 'a', count: '5' }, schema)).toEqual({
      success: true,
      data: { kind: 'a', count: 5 },
    })
  })
}

it('uses optional and nullable discriminator values supported by Zod', () => {
  const schema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('a').optional(), count: z.number() }),
    z.object({ kind: z.literal('b').nullable(), name: z.string() }),
  ])
  expect(createParser(schema).parse('{"count":5}')).toMatchObject({
    success: true,
    value: { count: 5 },
  })
  expect(safeParseToolArgs({ kind: null, name: 'sample' }, schema)).toEqual({
    success: true,
    data: { kind: null, name: 'sample' },
  })
  expect(createParser(schema).parse('{"kind":"unknown","count":5}').success).toBe(false)
})
