import { z } from 'zod/v3'

import type { CoercionContext } from '../context'

import { childContext, addCorrection, addError } from '../context'
import {
  coerceIntersection as coerceIntersectionShared,
  coerceUnion as coerceUnionShared,
} from '../shared/unions'
import { normalizeEnumValue } from './enums'

export type CoerceValueFn = (value: unknown, schema: z.ZodType, ctx: CoercionContext) => unknown

export function coerceUnion(
  value: unknown,
  schema: z.ZodUnion<[z.ZodType, ...z.ZodType[]]>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown {
  return coerceUnionShared(value, schema.options, ctx, coerceValue)
}

export function coerceDiscriminatedUnion(
  value: unknown,
  schema: z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown {
  if (typeof value !== 'object' || value === null) {
    addError(ctx, 'discriminated_union', value, 'Expected object for discriminated union')
    return ctx.partial ? undefined : value
  }

  const discriminator = schema.discriminator
  const inputObj = value as Record<string, unknown>
  const discriminatorValue = inputObj[discriminator]

  if (discriminatorValue === undefined) {
    if (ctx.partial) return undefined
    addError(ctx, 'discriminated_union', value, `Missing discriminator field "${discriminator}"`)
    return value
  }

  const optionsMap = schema.optionsMap
  let matchedSchema = optionsMap.get(discriminatorValue as string)

  if (!matchedSchema && typeof discriminatorValue === 'string') {
    const entries = Array.from(optionsMap.entries())
    for (let i = 0; i < entries.length; i++) {
      const [key, optionSchema] = entries[i]
      if (normalizeEnumValue(String(key)) === normalizeEnumValue(discriminatorValue)) {
        matchedSchema = optionSchema
        addCorrection(
          childContext(ctx, discriminator),
          discriminatorValue,
          key,
          'Matched discriminator case-insensitively',
          'enumCaseNormalized',
        )
        ;(inputObj as Record<string, unknown>)[discriminator] = key
        break
      }
    }
  }

  if (!matchedSchema) {
    addError(
      ctx,
      `discriminated_union(${discriminator})`,
      discriminatorValue,
      `Invalid discriminator value "${discriminatorValue}"`,
    )
    return ctx.partial ? undefined : value
  }

  return coerceValue(value, matchedSchema, ctx)
}

export function coerceIntersection(
  value: unknown,
  schema: z.ZodIntersection<z.ZodType, z.ZodType>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown {
  return coerceIntersectionShared(value, schema._def.left, schema._def.right, ctx, coerceValue)
}
