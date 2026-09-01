import { zodResponsesFunction } from 'openai/helpers/zod'
import { vi } from 'vitest'
import { z } from 'zod'

import { normalizeSchema, resetNormalizeWarning } from './normalizeSchema'

beforeEach(() => {
  resetNormalizeWarning()
})

describe('normalizeSchema', () => {
  it('returns the same reference when no optional fields need fixing', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    })
    expect(normalizeSchema(schema, 'test')).toBe(schema)
  })

  it('returns the same reference when optional fields already have nullable', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().nullable().optional(),
    })
    expect(normalizeSchema(schema, 'test')).toBe(schema)
  })

  it('wraps optional fields with nullable', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    })
    const result = normalizeSchema(schema, 'test') as z.ZodObject<any>

    expect(result).not.toBe(schema)
    expect(result.shape.name).toBe(schema.shape.name)
    expect(result.shape.nickname.isOptional()).toBe(true)
    expect(result.shape.nickname.isNullable()).toBe(true)
  })

  it('preserves descriptions on fixed fields', () => {
    const schema = z.object({
      nickname: z.string().optional().describe('A nickname'),
    })
    const result = normalizeSchema(schema, 'test') as z.ZodObject<any>
    const def = (result.shape.nickname as any)._def
    expect(def.description).toBe('A nickname')
  })

  it('normalizes nested objects', () => {
    const schema = z.object({
      address: z.object({
        street: z.string(),
        unit: z.string().optional(),
      }),
    })
    const result = normalizeSchema(schema, 'test') as z.ZodObject<any>
    const inner = result.shape.address as z.ZodObject<any>
    expect(inner.shape.unit.isOptional()).toBe(true)
    expect(inner.shape.unit.isNullable()).toBe(true)
  })

  it('normalizes objects inside arrays', () => {
    const schema = z.object({
      items: z.array(
        z.object({
          label: z.string(),
          value: z.string().optional(),
        }),
      ),
    })
    const result = normalizeSchema(schema, 'test') as z.ZodObject<any>
    const arrayDef = (result.shape.items as any)._def
    const elementShape = arrayDef.type.shape
    expect(elementShape.value.isOptional()).toBe(true)
    expect(elementShape.value.isNullable()).toBe(true)
  })

  it('normalizes objects inside unions', () => {
    const schema = z.union([
      z.object({ type: z.literal('a'), extra: z.string().optional() }),
      z.object({ type: z.literal('b') }),
    ])
    const result = normalizeSchema(schema, 'test')
    const opts = (result as any)._def.options
    expect(opts[0].shape.extra.isOptional()).toBe(true)
    expect(opts[0].shape.extra.isNullable()).toBe(true)
  })

  it('normalizes objects inside discriminated unions', () => {
    const schema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('a'), extra: z.string().optional() }),
      z.object({ type: z.literal('b'), extra: z.number().optional() }),
    ])
    const result = normalizeSchema(schema, 'test')
    const opts = (result as any)._def.options
    expect(opts[0].shape.extra.isNullable()).toBe(true)
    expect(opts[1].shape.extra.isNullable()).toBe(true)
  })

  it('preserves strict mode on objects', () => {
    const schema = z
      .object({
        name: z.string(),
        tag: z.string().optional(),
      })
      .strict()
    const result = normalizeSchema(schema, 'test') as z.ZodObject<any>
    expect((result as any)._def.unknownKeys).toBe('strict')
  })

  it('does not modify fields with defaults', () => {
    const schema = z.object({
      count: z.number().default(0),
    })
    expect(normalizeSchema(schema, 'test')).toBe(schema)
  })

  it('handles optional nullable in either order', () => {
    const schema1 = z.object({ a: z.string().nullable().optional() })
    const schema2 = z.object({ a: z.string().optional().nullable() })
    expect(normalizeSchema(schema1, 'test')).toBe(schema1)
    expect(normalizeSchema(schema2, 'test')).toBe(schema2)
  })

  it('warns once on first normalization', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation()

    const schema = z.object({ a: z.string().optional() })
    normalizeSchema(schema, 'first')
    normalizeSchema(schema, 'second')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Auto-patched Zod schema "first"'))

    spy.mockRestore()
  })

  it('does not warn when no normalization is needed', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation()

    const schema = z.object({ a: z.string().nullable().optional() })
    normalizeSchema(schema, 'test')

    expect(spy).not.toHaveBeenCalled()

    spy.mockRestore()
  })

  it('produces schemas that pass zodResponsesFunction without error', () => {
    const schema = z.object({
      nodeId: z.string().optional(),
      nested: z
        .object({
          value: z.number().optional(),
          items: z.array(
            z.object({
              id: z.string(),
              label: z.string().optional(),
            }),
          ),
        })
        .optional(),
    })

    expect(() =>
      zodResponsesFunction({
        name: 'test',
        description: 'test',
        parameters: schema,
      }),
    ).toThrow()

    const normalized = normalizeSchema(schema, 'test')

    expect(() =>
      zodResponsesFunction({
        name: 'test',
        description: 'test',
        parameters: normalized,
      }),
    ).not.toThrow()
  })

  it('normalizes record value types', () => {
    const schema = z.object({
      data: z.record(
        z.object({
          value: z.string().optional(),
        }),
      ),
    })
    const result = normalizeSchema(schema, 'test') as z.ZodObject<any>
    const recordDef = (result.shape.data as any)._def
    expect(recordDef.valueType.shape.value.isNullable()).toBe(true)
  })

  it('normalizes lazy schemas', () => {
    const schema = z.object({
      name: z.string(),
      child: z.lazy(() =>
        z.object({
          label: z.string().optional(),
        }),
      ),
    })
    const result = normalizeSchema(schema, 'test') as z.ZodObject<any>
    const lazyDef = (result.shape.child as any)._def
    const resolved = lazyDef.getter()
    expect(resolved.shape.label.isOptional()).toBe(true)
    expect(resolved.shape.label.isNullable()).toBe(true)
  })
})
