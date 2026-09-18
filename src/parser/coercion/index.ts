import type { ZodSchema } from '../../types/zod'
import type { CoercionResult, JsonishValue } from '../types'

import { isZod3Schema, isZod4Schema } from '../../types/zod'
import * as v3 from './v3/index'
import * as v4 from './v4/index'

export function coerce<T>(
  value: unknown,
  schema: ZodSchema<T>,
  options: { partial?: boolean } = {},
): CoercionResult<T> {
  if (isZod4Schema(schema)) return v4.coerce(value, schema, options) as CoercionResult<T>
  if (isZod3Schema(schema)) return v3.coerce(value, schema, options) as CoercionResult<T>
  throw new Error('Unsupported schema')
}

export function coercePartial<T>(value: unknown, schema: ZodSchema<T>): CoercionResult<Partial<T>> {
  return coerce(value, schema, { partial: true }) as CoercionResult<Partial<T>>
}

export function coerceFromJsonish<T>(
  jsonish: JsonishValue,
  schema: ZodSchema<T>,
  options: { partial?: boolean } = {},
): CoercionResult<T> {
  if (isZod4Schema(schema))
    return v4.coerceFromJsonish(jsonish, schema, options) as CoercionResult<T>
  if (isZod3Schema(schema))
    return v3.coerceFromJsonish(jsonish, schema, options) as CoercionResult<T>
  throw new Error('Unsupported schema')
}
