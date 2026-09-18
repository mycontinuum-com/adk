import { z } from 'zod/v4'

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
  const hasUrlFormat = (schema.def.checks ?? []).some(
    (check) => 'format' in check._zod.def && check._zod.def.format === 'url',
  )
  return applyUrlRefinement(value, hasUrlFormat, ctx)
}
