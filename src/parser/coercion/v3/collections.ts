import { z } from 'zod/v3'

import type { CoercionContext } from '../context'

import {
  coerceArray as coerceArrayShared,
  coerceMap as coerceMapShared,
  coerceObject as coerceObjectShared,
  coerceRecord as coerceRecordShared,
  coerceSet as coerceSetShared,
  coerceTuple as coerceTupleShared,
} from '../shared/collections'

export type CoerceValueFn = (value: unknown, schema: z.ZodType, ctx: CoercionContext) => unknown

export function coerceArray(
  value: unknown,
  schema: z.ZodArray<z.ZodType>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown[] | undefined {
  return coerceArrayShared(value, schema.element, ctx, coerceValue)
}

export function coerceObject(
  value: unknown,
  schema: z.ZodObject<z.ZodRawShape>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): Record<string, unknown> | undefined {
  return coerceObjectShared(
    value,
    schema.shape,
    schema._def.unknownKeys === 'passthrough',
    ctx,
    coerceValue,
  )
}

export function coerceRecord(
  value: unknown,
  schema: z.ZodRecord<z.ZodType, z.ZodType>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): Record<string, unknown> | undefined {
  return coerceRecordShared(value, schema.valueSchema, ctx, coerceValue)
}

export function coerceTuple(
  value: unknown,
  schema: z.ZodTuple<[z.ZodType, ...z.ZodType[]]>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown[] | undefined {
  return coerceTupleShared(value, schema.items, ctx, coerceValue)
}

export function coerceMap(
  value: unknown,
  schema: z.ZodMap<z.ZodType, z.ZodType>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): Map<unknown, unknown> | undefined {
  return coerceMapShared(value, schema.keySchema, schema.valueSchema, ctx, coerceValue)
}

export function coerceSet(
  value: unknown,
  schema: z.ZodSet<z.ZodType>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): Set<unknown> | undefined {
  return coerceSetShared(value, schema._def.valueType, ctx, coerceValue)
}
