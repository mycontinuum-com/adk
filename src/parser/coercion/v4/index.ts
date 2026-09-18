import { z } from 'zod/v4'

import type { CoercionResult, JsonishValue } from '../../types'
import type { CoercionContext } from '../context'

import { jsonishToPlain } from '../../types'
import { createContext, addCorrection, addError, totalScore, isMaxDepthExceeded } from '../context'
import {
  coerceArray,
  coerceObject,
  coerceRecord,
  coerceTuple,
  coerceMap,
  coerceSet,
} from './collections'
import { coerceToEnum, getEnumValues } from './enums'
import {
  coerceToString,
  applyStringRefinements,
  coerceToNumber,
  coerceToBoolean,
  coerceToDate,
  coerceToBigInt,
} from './primitives'
import { coerceUnion, coerceDiscriminatedUnion, coerceIntersection } from './unions'

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

const PRIMITIVE_TYPE_NAMES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'date',
  'enum',
  'enum',
  'literal',
])

type SchemaDef = {
  type?: string
  defaultValue?: unknown
  innerType?: z.ZodType
  catchValue?: unknown
  getter?: () => z.ZodType
  in?: z.ZodType
  out?: z.ZodType
  unknownKeys?: string
}

function defOf(schema: z.ZodType): SchemaDef {
  return (schema as unknown as { def: SchemaDef }).def
}

function coerceValue(value: unknown, schema: z.ZodType, ctx: CoercionContext): unknown {
  if (isMaxDepthExceeded(ctx)) {
    addError(ctx, 'any', value, 'Maximum coercion depth exceeded (possible circular reference)')
    return ctx.partial ? undefined : value
  }

  const def = defOf(schema)
  const type = def?.type

  if (type === 'default') {
    if ((value === undefined || value === null) && 'defaultValue' in def) {
      const defaultVal = def.defaultValue
      addCorrection(ctx, value, defaultVal, 'Applied default value', 'defaultFromNoValue')
      return defaultVal
    }
    if (def.innerType) {
      return coerceValue(value, def.innerType, ctx)
    }
  }

  switch (type) {
    case 'string': {
      const result = coerceToString(value, ctx)
      if (result !== undefined) {
        return applyStringRefinements(result, schema, ctx)
      }
      return result
    }

    case 'number':
      return coerceToNumber(value, ctx)

    case 'boolean':
      return coerceToBoolean(value, ctx)

    case 'date':
      return coerceToDate(value, ctx)

    case 'bigint':
      return coerceToBigInt(value, ctx)

    case 'literal': {
      const literal = (schema as z.ZodLiteral).value
      if (value === literal) return value
      if (typeof literal === 'string' && typeof value === 'string') {
        if (value.toLowerCase() === literal.toLowerCase()) {
          addCorrection(
            ctx,
            value,
            literal,
            'Matched literal case-insensitively',
            'enumCaseNormalized',
          )
          return literal
        }
      }
      addError(ctx, `literal(${JSON.stringify(literal)})`, value, 'Value does not match literal')
      return ctx.partial ? undefined : value
    }

    case 'enum':
      return coerceToEnum(value, getEnumValues(schema as z.ZodEnum), ctx)

    case 'null': {
      if (value === null) return null
      if (value === undefined && ctx.partial) return undefined
      addError(ctx, 'null', value, 'Expected null')
      return ctx.partial ? undefined : value
    }

    case 'undefined': {
      if (value === undefined) return undefined
      addError(ctx, 'undefined', value, 'Expected undefined')
      return undefined
    }

    case 'optional': {
      if (value === undefined || value === null) return undefined
      const inner = def.innerType!
      const innerTypeName = defOf(inner)?.type
      if (isEmptyObject(value) && PRIMITIVE_TYPE_NAMES.has(innerTypeName ?? '')) {
        addCorrection(
          ctx,
          value,
          undefined,
          'Treated empty object as absent for optional primitive',
          'emptyObjectToUndefined',
        )
        return undefined
      }
      return coerceValue(value, inner, ctx)
    }

    case 'nullable': {
      if (value === null) return null
      if (value === undefined && ctx.partial) return undefined
      return coerceValue(value, def.innerType!, ctx)
    }

    case 'array':
      return coerceArray(value, schema as z.ZodArray<z.ZodType>, ctx, coerceValue)

    case 'object':
      return coerceObject(value, schema as z.ZodObject<z.ZodRawShape>, ctx, coerceValue)

    case 'union':
      return schema instanceof z.ZodDiscriminatedUnion
        ? coerceDiscriminatedUnion(value, schema, ctx, coerceValue)
        : coerceUnion(value, schema as z.ZodUnion<any>, ctx, coerceValue)

    case 'record':
      return coerceRecord(value, schema as z.ZodRecord<z.ZodString, z.ZodType>, ctx, coerceValue)

    case 'tuple':
      return coerceTuple(value, schema as z.ZodTuple<any>, ctx, coerceValue)

    case 'any':
    case 'unknown':
      return value

    case 'lazy':
      return coerceValue(value, def.getter!(), ctx)

    case 'intersection':
      return coerceIntersection(value, schema as z.ZodIntersection<any, any>, ctx, coerceValue)

    case 'catch': {
      const testCtx = createContext(ctx.partial, ctx.visited)
      const result = coerceValue(value, def.innerType!, testCtx)
      if (testCtx.errors.length > 0) {
        const resolvedCatch =
          typeof def.catchValue === 'function' ? def.catchValue() : def.catchValue
        addCorrection(
          ctx,
          value,
          resolvedCatch,
          'Used catch fallback due to coercion errors',
          'defaultFromNoValue',
        )
        return resolvedCatch
      }
      ctx.corrections.push(...testCtx.corrections)
      return result
    }

    case 'map':
      return coerceMap(value, schema as z.ZodMap<z.ZodType, z.ZodType>, ctx, coerceValue)

    case 'set':
      return coerceSet(value, schema as z.ZodSet<z.ZodType>, ctx, coerceValue)

    case 'pipe': {
      const intermediate = coerceValue(value, def.in!, ctx)
      return coerceValue(intermediate, def.out!, ctx)
    }

    default:
      return value
  }
}

function extractBestStringFromAnyOf(jsonish: JsonishValue): string | undefined {
  if (jsonish.type !== 'anyOf') return undefined

  const originalString = jsonish.originalString

  for (const candidate of jsonish.candidates) {
    if (candidate.type === 'string' && typeof candidate.value === 'string') {
      if (originalString.startsWith(candidate.value) || candidate.value === originalString) {
        return candidate.value
      }
    }
  }

  return originalString
}

export function coerceFromJsonish<T>(
  jsonish: JsonishValue,
  schema: z.ZodType<T>,
  options: { partial?: boolean } = {},
): CoercionResult<T> {
  if (jsonish.type === 'anyOf') {
    if (schema instanceof z.ZodString) {
      const stringValue = extractBestStringFromAnyOf(jsonish)
      if (stringValue !== undefined) {
        return {
          success: true,
          value: stringValue as T,
          corrections: [],
          totalScore: 0,
        }
      }
    }

    let bestResult: CoercionResult<T> | undefined
    let bestScore = Infinity

    for (const candidate of jsonish.candidates) {
      const result = coerceFromJsonish(candidate, schema, options)
      if (result.success && result.totalScore < bestScore) {
        bestResult = result
        bestScore = result.totalScore
        if (bestScore === 0) break
      } else if (!result.success && !bestResult) {
        bestResult = result
      }
    }

    return (
      bestResult || {
        success: false,
        errors: [
          {
            path: [],
            expected: 'any',
            received: jsonish,
            message: 'No valid candidates',
          },
        ],
        corrections: [],
        totalScore: Infinity,
      }
    )
  }

  const plain = jsonishToPlain(jsonish)
  return coerce(plain, schema, options)
}

export function coerce<T>(
  value: unknown,
  schema: z.ZodType<T>,
  options: { partial?: boolean } = {},
): CoercionResult<T> {
  const ctx = createContext(options.partial ?? false)
  const result = coerceValue(value, schema, ctx)
  const score = totalScore(ctx.corrections)

  if (ctx.errors.length === 0) {
    return {
      success: true,
      value: result as T,
      corrections: ctx.corrections,
      totalScore: score,
    }
  }

  return {
    success: false,
    errors: ctx.errors,
    partial: result as Partial<T>,
    corrections: ctx.corrections,
    totalScore: score,
  }
}
