import type { AnyZodSchema } from '../../../types/zod'
import type { Correction } from '../../types'
import type { CoercionContext } from '../context'

import { addCorrection, addError, createContext, totalScore } from '../context'

export type CoerceValueFn<Schema extends AnyZodSchema> = (
  value: unknown,
  schema: Schema,
  ctx: CoercionContext,
) => unknown

export function coerceUnion<Schema extends AnyZodSchema>(
  value: unknown,
  options: readonly Schema[],
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): unknown {
  if (ctx.unionVariantHint !== undefined && ctx.unionVariantHint < options.length) {
    const hintedOption = options[ctx.unionVariantHint]
    const testCtx = createContext(ctx.partial, ctx.visited, ctx.depth)
    const coerced = coerceValue(value, hintedOption, testCtx)

    if (testCtx.errors.length === 0 && totalScore(testCtx.corrections) === 0) {
      ctx.corrections.push(...testCtx.corrections)
      addCorrection(
        ctx,
        ctx.unionVariantHint,
        ctx.unionVariantHint,
        'Matched union variant from hint',
        'unionMatch',
      )
      return coerced
    }
  }

  let bestResult:
    | {
        value: unknown
        score: number
        corrections: Correction[]
        index: number
      }
    | undefined

  for (let i = 0; i < options.length; i++) {
    const option = options[i]
    const testCtx = createContext(ctx.partial, ctx.visited, ctx.depth)
    const coerced = coerceValue(value, option, testCtx)

    if (testCtx.errors.length === 0) {
      const score = totalScore(testCtx.corrections)

      if (score === 0) {
        ctx.corrections.push(...testCtx.corrections)
        addCorrection(ctx, i, i, 'Matched union variant', 'unionMatch')
        return coerced
      }

      if (!bestResult || score < bestResult.score) {
        bestResult = {
          value: coerced,
          score,
          corrections: testCtx.corrections,
          index: i,
        }
      }
    }
  }

  if (bestResult) {
    ctx.corrections.push(...bestResult.corrections)
    addCorrection(
      ctx,
      bestResult.index,
      bestResult.index,
      'Matched union variant (with coercions)',
      'unionMatch',
    )
    return bestResult.value
  }

  addError(ctx, 'union', value, 'Value does not match any union member')
  return ctx.partial ? undefined : value
}

export function coerceIntersection<Schema extends AnyZodSchema>(
  value: unknown,
  left: Schema,
  right: Schema,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): unknown {
  const leftCtx = createContext(ctx.partial, ctx.visited, ctx.depth)
  const rightCtx = createContext(ctx.partial, ctx.visited, ctx.depth)

  const leftResult = coerceValue(value, left, leftCtx)
  const rightResult = coerceValue(value, right, rightCtx)

  ctx.corrections.push(...leftCtx.corrections, ...rightCtx.corrections)

  if (leftCtx.errors.length > 0 || rightCtx.errors.length > 0) {
    ctx.errors.push(...leftCtx.errors, ...rightCtx.errors)
  }

  if (
    typeof leftResult === 'object' &&
    leftResult !== null &&
    typeof rightResult === 'object' &&
    rightResult !== null &&
    !Array.isArray(leftResult) &&
    !Array.isArray(rightResult)
  ) {
    return { ...leftResult, ...rightResult }
  }

  return rightResult ?? leftResult
}
