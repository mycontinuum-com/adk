import { z } from 'zod'
import { z as z3 } from 'zod/v3'

import { safeParseToolArgs } from '../core/tools'
import { registerSchemaBridge } from '../types/zod'
import { normalizeSchema } from './normalizeSchema'
import { zodToToolSchema } from './zodToJsonSchema'

it('sends input types and constraints to the model, then validates and transforms arguments', () => {
  const schema = z.object({
    count: z.number().min(1),
    label: z.string().min(2).optional().describe('Optional label'),
    length: z.string().transform((value) => value.length),
  })
  expect(zodToToolSchema('measure', 'Measure', schema)).toEqual({
    name: 'measure',
    description: 'Measure',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', minimum: 1 },
        label: {
          anyOf: [
            { type: 'string', minLength: 2, description: 'Optional label' },
            { type: 'null' },
          ],
        },
        length: { type: 'string' },
      },
      required: ['count', 'label', 'length'],
      additionalProperties: false,
    },
  })
  expect(safeParseToolArgs({ count: '5', label: null, length: 'hello' }, schema)).toEqual({
    success: true,
    data: { count: 5, length: 5 },
  })
  expect(safeParseToolArgs({ count: '0', length: 'hello' }, schema).success).toBe(false)
})

it('supports Zod 3 tool schemas without replacing their validation semantics', () => {
  const schema = z3.object({
    kind: z3.literal('measure'),
    count: z3.number().min(1),
    length: z3.string().transform((value) => value.length),
  })

  expect(zodToToolSchema('legacy_measure', 'Measure', schema).parameters).toMatchObject({
    type: 'object',
    properties: {
      kind: { type: 'string', const: 'measure' },
      count: { type: 'number', minimum: 1 },
      length: { type: 'string' },
    },
    required: ['kind', 'count', 'length'],
    additionalProperties: false,
  })
  expect(safeParseToolArgs({ kind: 'measure', count: '5', length: 'hello' }, schema)).toEqual({
    success: true,
    data: { kind: 'measure', count: 5, length: 5 },
  })
  expect(safeParseToolArgs({ kind: 'measure', count: '0', length: 'hello' }, schema).success).toBe(
    false,
  )
})

it('normalizes Zod 3 optional fields for model input', () => {
  const schema = z3.object({ count: z3.number(), label: z3.string().optional() })
  const normalized = normalizeSchema(schema, 'legacy')

  expect(normalized.safeParse({ count: 1, label: null }).success).toBe(true)
})

it('converts a foreign Zod 4 schema embedded in a Zod 3 composition bridge', () => {
  const original = z.object({ count: z.string().regex(/^\d+$/).transform(Number) })
  const bridge = z3.any().transform((value) => value)
  registerSchemaBridge(bridge, original)

  expect(zodToToolSchema('mixed', '', z3.object({ input: bridge })).parameters).toMatchObject({
    properties: {
      input: {
        type: 'object',
        properties: { count: { type: 'string', pattern: '^\\d+$' } },
      },
    },
  })
})

it('preserves array bounds and object refinements while normalizing optional fields', () => {
  const schema = z
    .array(
      z
        .object({ count: z.number(), label: z.string().optional() })
        .refine((value) => value.count > 0),
    )
    .min(2)
  const normalized = normalizeSchema(schema, 'bounded')
  expect(normalized.safeParse([{ count: 1, label: null }]).success).toBe(false)
  expect(
    normalized.safeParse([
      { count: 0, label: null },
      { count: 1, label: null },
    ]).success,
  ).toBe(false)
  expect(
    normalized.safeParse([
      { count: 1, label: null },
      { count: 2, label: null },
    ]).success,
  ).toBe(true)
})

it('rejects recursive and non-JSON tool types instead of erasing their constraints', () => {
  const recursive = z.object({
    get children() {
      return z.array(recursive)
    },
  })
  expect(() => zodToToolSchema('recursive', '', recursive)).toThrow()
  expect(() => zodToToolSchema('date', '', z.object({ at: z.date() }))).toThrow()
})

it('preserves passthrough and typed catchall input contracts', () => {
  expect(zodToToolSchema('loose', '', z.looseObject({ known: z.string() })).parameters).toEqual({
    type: 'object',
    properties: { known: { type: 'string' } },
    required: ['known'],
    additionalProperties: {},
  })
  expect(
    zodToToolSchema('counts', '', z.object({ known: z.string() }).catchall(z.number().min(0)))
      .parameters,
  ).toEqual({
    type: 'object',
    properties: { known: { type: 'string' } },
    required: ['known'],
    additionalProperties: { type: 'number', minimum: 0 },
  })
})

it('describes the input of a dynamic catch without erasing its constraints', () => {
  const schema = z.object({
    value: z
      .number()
      .min(1)
      .catch((ctx) => (ctx.input === undefined ? 1 : 2)),
  })
  expect(zodToToolSchema('fallback', '', schema).parameters).toEqual({
    type: 'object',
    properties: { value: { type: 'number', minimum: 1 } },
    required: ['value'],
    additionalProperties: false,
  })
  expect(safeParseToolArgs({ value: 5 }, schema)).toEqual({ success: true, data: { value: 5 } })
})

it('keeps mutually exclusive discriminated unions in the existing anyOf wire representation', () => {
  const schema = z.object({
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), count: z.number() }),
      z.object({ kind: z.literal('b'), name: z.string() }),
    ]),
  })
  expect(zodToToolSchema('action', '', schema).parameters).toMatchObject({
    properties: {
      action: {
        anyOf: [
          {
            type: 'object',
            properties: { kind: { type: 'string', const: 'a' }, count: { type: 'number' } },
          },
          {
            type: 'object',
            properties: { kind: { type: 'string', const: 'b' }, name: { type: 'string' } },
          },
        ],
      },
    },
  })
})

it('keeps Zod 3 descriptions written on optional, nullable and default wrappers', () => {
  const schema = z3.object({
    detail: z3.enum(['done', 'not_understood']).optional().describe('What the caller showed'),
    note: z3.string().nullable().describe('Free text'),
    inner: z3.string().describe('Inner wins').optional().describe('Outer loses'),
    nested: z3
      .object({ reason: z3.string().optional().describe('Why') })
      .optional()
      .describe('Nested block'),
    items: z3.array(z3.object({ id: z3.string().optional().describe('Option id') })),
  })
  expect(zodToToolSchema('end', 'End', schema).parameters.properties).toMatchObject({
    detail: { description: 'What the caller showed' },
    note: { description: 'Free text' },
    inner: { description: 'Inner wins' },
    nested: {
      description: 'Nested block',
      anyOf: [{ properties: { reason: { description: 'Why' } } }, { type: 'null' }],
    },
    items: { items: { properties: { id: { description: 'Option id' } } } },
  })
})
