import type { AnyZodSchema } from '../../../types/zod'
import type { CoercionContext } from '../context'

import {
  createContext,
  childContext,
  checkAndMarkVisited,
  addCorrection,
  addError,
} from '../context'

export type CoerceValueFn<Schema extends AnyZodSchema> = (
  value: unknown,
  schema: Schema,
  ctx: CoercionContext,
) => unknown

export interface CoercibleSchema extends AnyZodSchema {
  isOptional(): boolean
}

export function coerceArray<Schema extends AnyZodSchema>(
  value: unknown,
  elementSchema: Schema,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): unknown[] | undefined {
  if (value === null || value === undefined) {
    if (ctx.partial) return undefined
    addError(ctx, 'array', value, 'Expected array but got null/undefined')
    return undefined
  }

  if (!Array.isArray(value)) {
    if (typeof value === 'string' && value.includes(',')) {
      const parts = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length > 1) {
        const result: unknown[] = []
        let allValid = true
        const partialCtx = createContext(ctx.partial, ctx.visited, ctx.depth)

        for (let i = 0; i < parts.length; i++) {
          const itemCtx = childContext(partialCtx, i)
          const itemCoerced = coerceValue(parts[i], elementSchema, itemCtx)
          if (partialCtx.errors.length > 0) {
            allValid = false
            break
          }
          result.push(itemCoerced)
        }

        if (allValid) {
          addCorrection(
            ctx,
            value,
            result,
            'Split comma-separated string into array',
            'commaSeparatedToArray',
          )
          ctx.corrections.push(...partialCtx.corrections)
          return result
        }
      }
    }

    const testCtx = createContext(ctx.partial, ctx.visited, ctx.depth)
    const coerced = coerceValue(value, elementSchema, testCtx)

    if (testCtx.errors.length === 0) {
      addCorrection(ctx, value, [coerced], 'Wrapped single value in array', 'singleToArray')
      ctx.corrections.push(...testCtx.corrections)
      return [coerced]
    }

    addError(ctx, 'array', value, `Expected array but got ${typeof value}`)
    return undefined
  }

  const result: unknown[] = []
  let lastUnionIndex: number | undefined

  for (let i = 0; i < value.length; i++) {
    ctx.unionVariantHint = lastUnionIndex
    const itemCtx = childContext(ctx, i)
    const coerced = coerceValue(value[i], elementSchema, itemCtx)

    const unionMatch = itemCtx.corrections.find((c) => c.type === 'unionMatch')
    if (unionMatch && typeof unionMatch.to === 'number') {
      lastUnionIndex = unionMatch.to
    }

    ctx.corrections.push(...itemCtx.corrections)
    ctx.errors.push(...itemCtx.errors)
    result.push(coerced)
  }

  return result
}

function findKeyInsensitive(
  inputObj: Record<string, unknown>,
  targetKey: string,
): { key: string; value: unknown } | undefined {
  if (targetKey in inputObj) {
    return { key: targetKey, value: inputObj[targetKey] }
  }

  const lowerTarget = targetKey.toLowerCase()
  for (const inputKey of Object.keys(inputObj)) {
    if (inputKey.toLowerCase() === lowerTarget) {
      return { key: inputKey, value: inputObj[inputKey] }
    }
  }

  const normalizedTarget = targetKey.toLowerCase().replace(/[_-]/g, '')
  for (const inputKey of Object.keys(inputObj)) {
    const normalizedInput = inputKey.toLowerCase().replace(/[_-]/g, '')
    if (normalizedInput === normalizedTarget) {
      return { key: inputKey, value: inputObj[inputKey] }
    }
  }

  return undefined
}

export function coerceObject<Schema extends CoercibleSchema>(
  value: unknown,
  shape: Record<string, Schema>,
  passthrough: boolean,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    if (value === null || value === undefined) {
      if (ctx.partial) return undefined
    }
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    addError(ctx, 'object', value, `Expected object but got ${actualType}`)
    return undefined
  }

  const schemaId = 'object:' + Object.keys(shape).toSorted().join(',')
  if (checkAndMarkVisited(ctx, schemaId, value)) {
    addError(ctx, 'object', value, 'Circular reference detected')
    return undefined
  }

  const result: Record<string, unknown> = {}
  const inputObj = value as Record<string, unknown>
  const usedInputKeys = new Set<string>()

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const fieldCtx = childContext(ctx, key)
    const found = findKeyInsensitive(inputObj, key)

    if (found) {
      usedInputKeys.add(found.key)
      if (found.key !== key) {
        addCorrection(
          fieldCtx,
          found.key,
          key,
          'Matched field name case-insensitively',
          'keyCaseNormalized',
        )
      }
    }

    const inputValue = found?.value
    const coerced = coerceValue(inputValue, fieldSchema, fieldCtx)

    ctx.corrections.push(...fieldCtx.corrections)
    ctx.errors.push(...fieldCtx.errors)

    if (coerced !== undefined) {
      result[key] = coerced
    } else if (!ctx.partial && !fieldSchema.isOptional()) {
      addError(fieldCtx, 'required', undefined, `Missing required field "${key}"`)
      ctx.errors.push(...fieldCtx.errors)
    }
  }

  for (const [inputKey, val] of Object.entries(inputObj)) {
    if (!usedInputKeys.has(inputKey)) {
      if (passthrough) {
        result[inputKey] = val
      } else {
        addCorrection(ctx, inputKey, undefined, `Extra key "${inputKey}" ignored`, 'extraKey')
      }
    }
  }

  if (Object.keys(result).length === 0 && Object.keys(shape).length > 0) {
    addCorrection(ctx, value, result, 'Object had no matching fields', 'noFields')
  }

  return result
}

export function coerceRecord<Schema extends AnyZodSchema>(
  value: unknown,
  valueSchema: Schema,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    if (ctx.partial && (value === null || value === undefined)) return undefined
    addError(ctx, 'record', value, `Expected object but got ${typeof value}`)
    return undefined
  }

  const result: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const itemCtx = childContext(ctx, key)
    const coerced = coerceValue(val, valueSchema, itemCtx)
    ctx.corrections.push(...itemCtx.corrections)
    ctx.errors.push(...itemCtx.errors)
    if (coerced !== undefined || !ctx.partial) {
      result[key] = coerced
    }
  }

  return result
}

export function coerceTuple<Schema extends AnyZodSchema>(
  value: unknown,
  items: readonly Schema[],
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    if (ctx.partial && (value === null || value === undefined)) return undefined
    addError(ctx, 'tuple', value, `Expected array but got ${typeof value}`)
    return undefined
  }

  const result: unknown[] = []

  for (let i = 0; i < items.length; i++) {
    const itemCtx = childContext(ctx, i)
    const coerced = coerceValue(value[i], items[i], itemCtx)
    ctx.corrections.push(...itemCtx.corrections)
    ctx.errors.push(...itemCtx.errors)
    result.push(coerced)
  }

  return result
}

export function coerceMap<Schema extends AnyZodSchema>(
  value: unknown,
  keySchema: Schema,
  valueSchema: Schema,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): Map<unknown, unknown> | undefined {
  if (value instanceof Map) {
    const result = new Map<unknown, unknown>()

    const entries = Array.from(value.entries())
    for (let index = 0; index < entries.length; index++) {
      const [k, v] = entries[index]
      const keyCtx = childContext(ctx, `key_${index}`)
      const valCtx = childContext(ctx, `value_${index}`)
      result.set(coerceValue(k, keySchema, keyCtx), coerceValue(v, valueSchema, valCtx))
      ctx.corrections.push(...keyCtx.corrections, ...valCtx.corrections)
      ctx.errors.push(...keyCtx.errors, ...valCtx.errors)
    }
    return result
  }

  if (value === null || value === undefined) {
    if (ctx.partial) return undefined
    addError(ctx, 'map', value, 'Expected Map but got null/undefined')
    return undefined
  }

  if (Array.isArray(value)) {
    const result = new Map<unknown, unknown>()

    for (let i = 0; i < value.length; i++) {
      const entry = value[i]
      if (Array.isArray(entry) && entry.length === 2) {
        const keyCtx = childContext(ctx, `${i}.key`)
        const valCtx = childContext(ctx, `${i}.value`)
        result.set(
          coerceValue(entry[0], keySchema, keyCtx),
          coerceValue(entry[1], valueSchema, valCtx),
        )
        ctx.corrections.push(...keyCtx.corrections, ...valCtx.corrections)
        ctx.errors.push(...keyCtx.errors, ...valCtx.errors)
      }
    }

    if (result.size > 0) {
      addCorrection(ctx, value, result, 'Converted array of entries to Map', 'objectToMap')
      return result
    }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const result = new Map<unknown, unknown>()

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyCtx = childContext(ctx, k)
      const valCtx = childContext(ctx, k)
      result.set(coerceValue(k, keySchema, keyCtx), coerceValue(v, valueSchema, valCtx))
      ctx.corrections.push(...keyCtx.corrections, ...valCtx.corrections)
      ctx.errors.push(...keyCtx.errors, ...valCtx.errors)
    }

    addCorrection(ctx, value, result, 'Converted object to Map', 'objectToMap')
    return result
  }

  addError(ctx, 'map', value, `Cannot coerce ${typeof value} to Map`)
  return undefined
}

export function coerceSet<Schema extends AnyZodSchema>(
  value: unknown,
  elementSchema: Schema,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn<Schema>,
): Set<unknown> | undefined {
  if (value instanceof Set) {
    const result = new Set<unknown>()

    const items = Array.from(value)
    for (let index = 0; index < items.length; index++) {
      const itemCtx = childContext(ctx, index)
      result.add(coerceValue(items[index], elementSchema, itemCtx))
      ctx.corrections.push(...itemCtx.corrections)
      ctx.errors.push(...itemCtx.errors)
    }
    return result
  }

  if (value === null || value === undefined) {
    if (ctx.partial) return undefined
    addError(ctx, 'set', value, 'Expected Set but got null/undefined')
    return undefined
  }

  if (Array.isArray(value)) {
    const result = new Set<unknown>()

    for (let i = 0; i < value.length; i++) {
      const itemCtx = childContext(ctx, i)
      result.add(coerceValue(value[i], elementSchema, itemCtx))
      ctx.corrections.push(...itemCtx.corrections)
      ctx.errors.push(...itemCtx.errors)
    }

    addCorrection(ctx, value, result, 'Converted array to Set', 'arrayToSet')
    return result
  }

  addError(ctx, 'set', value, `Cannot coerce ${typeof value} to Set`)
  return undefined
}
