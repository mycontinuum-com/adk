import { z } from 'zod/v3'

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
import { coerceToEnum, getEnumValues, getNativeEnumValues } from './enums'
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
  'ZodString',
  'ZodNumber',
  'ZodBoolean',
  'ZodBigInt',
  'ZodDate',
  'ZodEnum',
  'ZodNativeEnum',
  'ZodLiteral',
])

type SchemaDef = {
  typeName?: string
  defaultValue?: () => unknown
  innerType?: z.ZodType
  catchValue?: unknown
  schema?: z.ZodType
  getter?: () => z.ZodType
  in?: z.ZodType
  out?: z.ZodType
  unknownKeys?: string
}

function defOf(schema: z.ZodType): SchemaDef {
  return (schema as unknown as { _def: SchemaDef })._def
}

function coerceValue(value: unknown, schema: z.ZodType, ctx: CoercionContext): unknown {
  if (isMaxDepthExceeded(ctx)) {
    addError(ctx, 'any', value, 'Maximum coercion depth exceeded (possible circular reference)')
    return ctx.partial ? undefined : value
  }

  const def = defOf(schema)
  const typeName = def?.typeName

  if (typeName === 'ZodDefault') {
    if ((value === undefined || value === null) && typeof def.defaultValue === 'function') {
      const defaultVal = def.defaultValue()
      addCorrection(ctx, value, defaultVal, 'Applied default value', 'defaultFromNoValue')
      return defaultVal
    }
    if (def.innerType) {
      return coerceValue(value, def.innerType, ctx)
    }
  }

  const coercer = typeName === undefined ? undefined : COERCERS_BY_TYPE_NAME.get(typeName)
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
  const literal = (schema as z.ZodLiteral<unknown>).value
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
  const innerTypeName = defOf(inner)?.typeName
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

const COERCERS_BY_TYPE_NAME = new Map<string, Coercer>([
  ['ZodString', (value, schema, _def, ctx) => coerceStringValue(value, schema, ctx)],
  ['ZodNumber', (value, _schema, _def, ctx) => coerceToNumber(value, ctx)],
  ['ZodBoolean', (value, _schema, _def, ctx) => coerceToBoolean(value, ctx)],
  ['ZodDate', (value, _schema, _def, ctx) => coerceToDate(value, ctx)],
  ['ZodBigInt', (value, _schema, _def, ctx) => coerceToBigInt(value, ctx)],
  ['ZodLiteral', (value, schema, _def, ctx) => coerceLiteralValue(value, schema, ctx)],
  [
    'ZodEnum',
    (value, schema, _def, ctx) =>
      coerceToEnum(value, getEnumValues(schema as z.ZodEnum<[string, ...string[]]>), ctx),
  ],
  [
    'ZodNativeEnum',
    (value, schema, _def, ctx) =>
      coerceToEnum(value, getNativeEnumValues(schema as z.ZodNativeEnum<any>), ctx),
  ],
  ['ZodNull', (value, _schema, _def, ctx) => coerceNullValue(value, ctx)],
  ['ZodUndefined', (value, _schema, _def, ctx) => coerceUndefinedValue(value, ctx)],
  ['ZodOptional', (value, _schema, def, ctx) => coerceOptionalValue(value, def, ctx)],
  ['ZodNullable', (value, _schema, def, ctx) => coerceNullableValue(value, def, ctx)],
  [
    'ZodArray',
    (value, schema, _def, ctx) =>
      coerceArray(value, schema as z.ZodArray<z.ZodType>, ctx, coerceValue),
  ],
  [
    'ZodObject',
    (value, schema, _def, ctx) =>
      coerceObject(value, schema as z.ZodObject<z.ZodRawShape>, ctx, coerceValue),
  ],
  [
    'ZodUnion',
    (value, schema, _def, ctx) => coerceUnion(value, schema as z.ZodUnion<any>, ctx, coerceValue),
  ],
  [
    'ZodDiscriminatedUnion',
    (value, schema, _def, ctx) =>
      coerceDiscriminatedUnion(
        value,
        schema as z.ZodDiscriminatedUnion<any, any>,
        ctx,
        coerceValue,
      ),
  ],
  [
    'ZodRecord',
    (value, schema, _def, ctx) => coerceRecord(value, schema as z.ZodRecord<any>, ctx, coerceValue),
  ],
  [
    'ZodTuple',
    (value, schema, _def, ctx) => coerceTuple(value, schema as z.ZodTuple<any>, ctx, coerceValue),
  ],
  ['ZodAny', (value) => value],
  ['ZodUnknown', (value) => value],
  ['ZodEffects', (value, _schema, def, ctx) => coerceValue(value, def.schema!, ctx)],
  ['ZodLazy', (value, _schema, def, ctx) => coerceValue(value, def.getter!(), ctx)],
  [
    'ZodIntersection',
    (value, schema, _def, ctx) =>
      coerceIntersection(value, schema as z.ZodIntersection<any, any>, ctx, coerceValue),
  ],
  ['ZodCatch', (value, _schema, def, ctx) => coerceCatchValue(value, def, ctx)],
  ['ZodMap', (value, schema, _def, ctx) => coerceMap(value, schema as z.ZodMap, ctx, coerceValue)],
  ['ZodSet', (value, schema, _def, ctx) => coerceSet(value, schema as z.ZodSet, ctx, coerceValue)],
  [
    'ZodPipeline',
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
