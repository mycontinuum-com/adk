import { z } from 'zod/v4'

import type { CoercionResult, JsonishValue } from '../../types'
import type { CoercionContext } from '../context'

import { jsonishToPlain } from '../../types'
import {
  addCorrection,
  addError,
  branchContext,
  createContext,
  isMaxDepthExceeded,
  totalScore,
} from '../context'
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

  const coercer = type === undefined ? undefined : COERCERS_BY_TYPE.get(type)
  return coercer ? coercer(value, schema, def, ctx) : value
}

type Coercer = (value: unknown, schema: z.ZodType, def: SchemaDef, ctx: CoercionContext) => unknown

function coerceStringValue(value: unknown, schema: z.ZodType, ctx: CoercionContext): unknown {
  const result = coerceToString(value, ctx)
  if (result !== undefined) {
    return applyStringRefinements(result, schema, ctx)
  }
  return result
}

function coerceLiteralValue(value: unknown, schema: z.ZodType, ctx: CoercionContext): unknown {
  const literal = (schema as z.ZodLiteral).value
  if (value === literal) return value
  if (typeof literal === 'string' && typeof value === 'string') {
    if (value.toLowerCase() === literal.toLowerCase()) {
      addCorrection(ctx, value, literal, 'Matched literal case-insensitively', 'enumCaseNormalized')
      return literal
    }
  }
  addError(ctx, `literal(${JSON.stringify(literal)})`, value, 'Value does not match literal')
  return ctx.partial ? undefined : value
}

function coerceNullValue(value: unknown, ctx: CoercionContext): unknown {
  if (value === null) return null
  if (value === undefined && ctx.partial) return undefined
  addError(ctx, 'null', value, 'Expected null')
  return ctx.partial ? undefined : value
}

function coerceUndefinedValue(value: unknown, ctx: CoercionContext): unknown {
  if (value === undefined) return undefined
  addError(ctx, 'undefined', value, 'Expected undefined')
  return undefined
}

function coerceOptionalValue(value: unknown, def: SchemaDef, ctx: CoercionContext): unknown {
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

function coerceNullableValue(value: unknown, def: SchemaDef, ctx: CoercionContext): unknown {
  if (value === null) return null
  if (value === undefined && ctx.partial) return undefined
  return coerceValue(value, def.innerType!, ctx)
}

function coerceCatchValue(value: unknown, def: SchemaDef, ctx: CoercionContext): unknown {
  const testCtx = branchContext(ctx)
  const result = coerceValue(value, def.innerType!, testCtx)
  if (testCtx.errors.length > 0) {
    const resolvedCatch = typeof def.catchValue === 'function' ? def.catchValue() : def.catchValue
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

const COERCERS_BY_TYPE = new Map<string, Coercer>([
  ['string', (value, schema, _def, ctx) => coerceStringValue(value, schema, ctx)],
  ['number', (value, _schema, _def, ctx) => coerceToNumber(value, ctx)],
  ['boolean', (value, _schema, _def, ctx) => coerceToBoolean(value, ctx)],
  ['date', (value, _schema, _def, ctx) => coerceToDate(value, ctx)],
  ['bigint', (value, _schema, _def, ctx) => coerceToBigInt(value, ctx)],
  ['literal', (value, schema, _def, ctx) => coerceLiteralValue(value, schema, ctx)],
  [
    'enum',
    (value, schema, _def, ctx) => coerceToEnum(value, getEnumValues(schema as z.ZodEnum), ctx),
  ],
  ['null', (value, _schema, _def, ctx) => coerceNullValue(value, ctx)],
  ['undefined', (value, _schema, _def, ctx) => coerceUndefinedValue(value, ctx)],
  ['optional', (value, _schema, def, ctx) => coerceOptionalValue(value, def, ctx)],
  ['nullable', (value, _schema, def, ctx) => coerceNullableValue(value, def, ctx)],
  [
    'array',
    (value, schema, _def, ctx) =>
      coerceArray(value, schema as z.ZodArray<z.ZodType>, ctx, coerceValue),
  ],
  [
    'object',
    (value, schema, _def, ctx) =>
      coerceObject(value, schema as z.ZodObject<z.ZodRawShape>, ctx, coerceValue),
  ],
  [
    'union',
    (value, schema, _def, ctx) =>
      schema instanceof z.ZodDiscriminatedUnion
        ? coerceDiscriminatedUnion(value, schema, ctx, coerceValue)
        : coerceUnion(value, schema as z.ZodUnion<any>, ctx, coerceValue),
  ],
  [
    'record',
    (value, schema, _def, ctx) =>
      coerceRecord(value, schema as z.ZodRecord<z.ZodString, z.ZodType>, ctx, coerceValue),
  ],
  [
    'tuple',
    (value, schema, _def, ctx) => coerceTuple(value, schema as z.ZodTuple<any>, ctx, coerceValue),
  ],
  ['any', (value) => value],
  ['unknown', (value) => value],
  ['lazy', (value, _schema, def, ctx) => coerceValue(value, def.getter!(), ctx)],
  [
    'intersection',
    (value, schema, _def, ctx) =>
      coerceIntersection(value, schema as z.ZodIntersection<any, any>, ctx, coerceValue),
  ],
  ['catch', (value, _schema, def, ctx) => coerceCatchValue(value, def, ctx)],
  [
    'map',
    (value, schema, _def, ctx) =>
      coerceMap(value, schema as z.ZodMap<z.ZodType, z.ZodType>, ctx, coerceValue),
  ],
  [
    'set',
    (value, schema, _def, ctx) => coerceSet(value, schema as z.ZodSet<z.ZodType>, ctx, coerceValue),
  ],
  [
    'pipe',
    (value, _schema, def, ctx) => coerceValue(coerceValue(value, def.in!, ctx), def.out!, ctx),
  ],
])

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
