import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { adk } from '../api/app'
import { assertZod3Schema, assertZod3StateSchema } from './assert-zod-version'

/**
 * A zod 4 schema, as the shape the guard discriminates on rather than as an install. Adding zod 4
 * to this package's dev tree to test this would recreate the very resolution conflict the guard
 * exists to warn about, so the stand-in carries what a v4 schema carries: `_zod`, and a `_def`
 * without `typeName`.
 */
const zod4Schema = () => ({ _zod: { version: 4 }, _def: { type: 'string' }, parse: () => '' })

describe('the zod 4 guard', () => {
  it('rejects a zod 4 schema and says what to install', () => {
    expect(() => assertZod3Schema(zod4Schema(), 'app.tool(…)')).toThrow(/zod 4 schema/)
    expect(() => assertZod3Schema(zod4Schema(), 'app.tool(…)')).toThrow(/zod \^3\.25/)
  })

  it('names the call the user made, so the message points at their code', () => {
    expect(() => assertZod3Schema(zod4Schema(), "app.tool('lookup')")).toThrow(/app\.tool\('lookup'\)/)
  })

  // The control that matters: every real schema in this package is a zod 3 schema, so a false
  // positive here would refuse every correct program.
  it('passes every shape of real zod 3 schema', () => {
    for (const schema of [
      z.string(),
      z.number().int(),
      z.object({ a: z.string(), b: z.array(z.number()) }),
      z.union([z.string(), z.number()]),
      z.enum(['a', 'b']),
      z.string().optional(),
      z.record(z.string()),
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), v: z.string() }),
        z.object({ kind: z.literal('b'), v: z.number() }),
      ]),
    ]) {
      expect(() => assertZod3Schema(schema, 'test')).not.toThrow()
    }
  })

  it('ignores absent and non-schema values rather than guessing', () => {
    for (const value of [undefined, null, {}, 'string', 42, { _def: {} }]) {
      expect(() => assertZod3Schema(value, 'test')).not.toThrow()
    }
  })

  it('walks a state schema scope by scope', () => {
    expect(() =>
      assertZod3StateSchema({ session: { ok: z.string() } }, 'adk({ schema })'),
    ).not.toThrow()
    expect(() =>
      assertZod3StateSchema({ session: { bad: zod4Schema() } }, 'adk({ schema })'),
    ).toThrow(/zod 4 schema/)
    expect(() => assertZod3StateSchema(undefined, 'adk({ schema })')).not.toThrow()
  })
})

describe('the guard where a user meets it', () => {
  it('refuses a zod 4 state schema at adk()', () => {
    expect(() => adk({ name: 'x', schema: { session: { bad: zod4Schema() } } as never })).toThrow(
      /adk\(\{ schema \}\)/,
    )
  })

  it('refuses a zod 4 tool schema at app.tool()', () => {
    const app = adk({ name: 'x' })
    expect(() =>
      app.tool({
        name: 'lookup',
        description: 'x',
        schema: zod4Schema() as never,
        execute: () => ({}),
      }),
    ).toThrow(/app\.tool\('lookup'\)/)
  })

  it('builds an ordinary zod 3 app and tool untouched', () => {
    const app = adk({ name: 'x', schema: { session: { note: z.string() } } })
    expect(() =>
      app.tool({
        name: 'ok',
        description: 'x',
        schema: z.object({ q: z.string() }),
        execute: () => ({}),
      }),
    ).not.toThrow()
  })
})
