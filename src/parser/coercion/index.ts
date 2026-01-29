import { z } from 'zod';
import type { CoercionResult, JsonishValue } from '../types';
import { jsonishToPlain } from '../types';
import type { CoercionContext } from './context';
import {
  createContext,
  addCorrection,
  addError,
  totalScore,
  isMaxDepthExceeded,
} from './context';
import {
  coerceToString,
  applyStringRefinements,
  coerceToNumber,
  coerceToBoolean,
  coerceToDate,
  coerceToBigInt,
} from './primitives';
import { coerceToEnum, getEnumValues, getNativeEnumValues } from './enums';
import {
  coerceArray,
  coerceObject,
  coerceRecord,
  coerceTuple,
  coerceMap,
  coerceSet,
} from './collections';
import {
  coerceUnion,
  coerceDiscriminatedUnion,
  coerceIntersection,
} from './unions';

export {
  createContext,
  childContext,
  addCorrection,
  addError,
  totalScore,
  isMaxDepthExceeded,
} from './context';
export type { CoercionContext } from './context';

function coerceValue(
  value: unknown,
  schema: z.ZodType,
  ctx: CoercionContext,
): unknown {
  if (isMaxDepthExceeded(ctx)) {
    addError(
      ctx,
      'any',
      value,
      'Maximum coercion depth exceeded (possible circular reference)',
    );
    return ctx.partial ? undefined : value;
  }

  const schemaAny = schema as {
    _def?: {
      typeName?: string;
      defaultValue?: () => unknown;
      innerType?: z.ZodType;
    };
  };
  const def = schemaAny?._def;

  if (def?.typeName === 'ZodDefault') {
    if (
      (value === undefined || value === null) &&
      typeof def.defaultValue === 'function'
    ) {
      const defaultVal = def.defaultValue();
      addCorrection(
        ctx,
        value,
        defaultVal,
        'Applied default value',
        'defaultFromNoValue',
      );
      return defaultVal;
    }
    if (def.innerType) {
      return coerceValue(value, def.innerType, ctx);
    }
  }

  if (schema instanceof z.ZodString) {
    const result = coerceToString(value, ctx);
    if (result !== undefined) {
      return applyStringRefinements(result, schema, ctx);
    }
    return result;
  }

  if (schema instanceof z.ZodNumber) {
    return coerceToNumber(value, ctx);
  }

  if (schema instanceof z.ZodBoolean) {
    return coerceToBoolean(value, ctx);
  }

  if (schema instanceof z.ZodDate) {
    return coerceToDate(value, ctx);
  }

  if (schema instanceof z.ZodLiteral) {
    const literal = schema.value;
    if (value === literal) return value;
    if (typeof literal === 'string' && typeof value === 'string') {
      if (value.toLowerCase() === literal.toLowerCase()) {
        addCorrection(
          ctx,
          value,
          literal,
          'Matched literal case-insensitively',
          'enumCaseNormalized',
        );
        return literal;
      }
    }
    addError(
      ctx,
      `literal(${JSON.stringify(literal)})`,
      value,
      'Value does not match literal',
    );
    return ctx.partial ? undefined : value;
  }

  if (schema instanceof z.ZodEnum) {
    return coerceToEnum(value, getEnumValues(schema), ctx);
  }

  if (schema instanceof z.ZodNativeEnum) {
    return coerceToEnum(value, getNativeEnumValues(schema), ctx);
  }

  if (schema instanceof z.ZodNull) {
    if (value === null) return null;
    if (value === undefined && ctx.partial) return undefined;
    addError(ctx, 'null', value, 'Expected null');
    return ctx.partial ? undefined : value;
  }

  if (schema instanceof z.ZodUndefined) {
    if (value === undefined) return undefined;
    addError(ctx, 'undefined', value, 'Expected undefined');
    return undefined;
  }

  if (schema instanceof z.ZodOptional) {
    if (value === undefined || value === null) return undefined;
    return coerceValue(value, schema.unwrap(), ctx);
  }

  if (schema instanceof z.ZodNullable) {
    if (value === null) return null;
    if (value === undefined && ctx.partial) return undefined;
    return coerceValue(value, schema.unwrap(), ctx);
  }

  if (schema instanceof z.ZodArray) {
    return coerceArray(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodObject) {
    return coerceObject(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodUnion) {
    return coerceUnion(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    return coerceDiscriminatedUnion(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodRecord) {
    return coerceRecord(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodTuple) {
    return coerceTuple(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    return value;
  }

  if (schema instanceof z.ZodEffects) {
    return coerceValue(value, schema.innerType(), ctx);
  }

  if (schema instanceof z.ZodLazy) {
    return coerceValue(value, schema.schema, ctx);
  }

  if (schema instanceof z.ZodIntersection) {
    return coerceIntersection(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodCatch) {
    const innerSchema = (schema._def as { innerType: z.ZodType }).innerType;
    const catchValue = (schema._def as { catchValue: unknown }).catchValue;
    const testCtx = createContext(ctx.partial, ctx.visited);
    const result = coerceValue(value, innerSchema, testCtx);

    if (testCtx.errors.length > 0) {
      const resolvedCatch =
        typeof catchValue === 'function' ? catchValue() : catchValue;
      addCorrection(
        ctx,
        value,
        resolvedCatch,
        'Used catch fallback due to coercion errors',
        'defaultFromNoValue',
      );
      return resolvedCatch;
    }

    ctx.corrections.push(...testCtx.corrections);
    return result;
  }

  if (schema instanceof z.ZodBigInt) {
    return coerceToBigInt(value, ctx);
  }

  if (schema instanceof z.ZodMap) {
    return coerceMap(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodSet) {
    return coerceSet(value, schema, ctx, coerceValue);
  }

  if (schema instanceof z.ZodPipeline) {
    const pipelineSchema = schema._def as { in: z.ZodType; out: z.ZodType };
    const intermediate = coerceValue(value, pipelineSchema.in, ctx);
    return coerceValue(intermediate, pipelineSchema.out, ctx);
  }

  return value;
}

function extractBestStringFromAnyOf(jsonish: JsonishValue): string | undefined {
  if (jsonish.type !== 'anyOf') return undefined;

  const originalString = jsonish.originalString;

  for (const candidate of jsonish.candidates) {
    if (candidate.type === 'string' && typeof candidate.value === 'string') {
      if (
        originalString.startsWith(candidate.value) ||
        candidate.value === originalString
      ) {
        return candidate.value;
      }
    }
  }

  return originalString;
}

export function coerceFromJsonish<T>(
  jsonish: JsonishValue,
  schema: z.ZodType<T>,
  options: { partial?: boolean } = {},
): CoercionResult<T> {
  if (jsonish.type === 'anyOf') {
    if (schema instanceof z.ZodString) {
      const stringValue = extractBestStringFromAnyOf(jsonish);
      if (stringValue !== undefined) {
        return {
          success: true,
          value: stringValue as T,
          corrections: [],
          totalScore: 0,
        };
      }
    }

    let bestResult: CoercionResult<T> | undefined;
    let bestScore = Infinity;

    for (const candidate of jsonish.candidates) {
      const result = coerceFromJsonish(candidate, schema, options);
      if (result.success && result.totalScore < bestScore) {
        bestResult = result;
        bestScore = result.totalScore;
        if (bestScore === 0) break;
      } else if (!result.success && !bestResult) {
        bestResult = result;
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
    );
  }

  const plain = jsonishToPlain(jsonish);
  return coerce(plain, schema, options);
}

export function coerce<T>(
  value: unknown,
  schema: z.ZodType<T>,
  options: { partial?: boolean } = {},
): CoercionResult<T> {
  const ctx = createContext(options.partial ?? false);
  const result = coerceValue(value, schema, ctx);
  const score = totalScore(ctx.corrections);

  if (ctx.errors.length === 0) {
    return {
      success: true,
      value: result as T,
      corrections: ctx.corrections,
      totalScore: score,
    };
  }

  return {
    success: false,
    errors: ctx.errors,
    partial: result as Partial<T>,
    corrections: ctx.corrections,
    totalScore: score,
  };
}

export function coercePartial<T>(
  value: unknown,
  schema: z.ZodType<T>,
): CoercionResult<Partial<T>> {
  return coerce(value, schema, { partial: true }) as CoercionResult<Partial<T>>;
}
