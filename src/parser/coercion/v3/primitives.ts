import { z } from 'zod/v3'

import type { CoercionContext } from '../context'

import { applyUrlRefinement } from '../shared/primitives'

export {
  coerceToString,
  coerceToBigInt,
  coerceToNumber,
  coerceToBoolean,
  coerceToDate,
} from '../shared/primitives'

export function applyStringRefinements(
  value: string,
  schema: z.ZodType,
  ctx: CoercionContext,
): string {
  if (!(schema instanceof z.ZodString)) return value
  const checks = (schema._def as { checks?: Array<{ kind: string }> }).checks ?? []
  return applyUrlRefinement(
    value,
    checks.some((check) => check.kind === 'url'),
    ctx,
  )
}
