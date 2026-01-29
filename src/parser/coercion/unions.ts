import { z } from 'zod';
import type { Correction } from '../types';
import type { CoercionContext } from './context';
import {
  createContext,
  childContext,
  addCorrection,
  addError,
  totalScore,
} from './context';
import { normalizeEnumValue } from './enums';

export type CoerceValueFn = (
  value: unknown,
  schema: z.ZodType,
  ctx: CoercionContext,
) => unknown;

export function coerceUnion(
  value: unknown,
  schema: z.ZodUnion<[z.ZodType, ...z.ZodType[]]>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown {
  const options = schema.options;

  if (
    ctx.unionVariantHint !== undefined &&
    ctx.unionVariantHint < options.length
  ) {
    const hintedOption = options[ctx.unionVariantHint];
    const testCtx = createContext(ctx.partial, ctx.visited, ctx.depth);
    const coerced = coerceValue(value, hintedOption, testCtx);

    if (testCtx.errors.length === 0 && totalScore(testCtx.corrections) === 0) {
      ctx.corrections.push(...testCtx.corrections);
      addCorrection(
        ctx,
        ctx.unionVariantHint,
        ctx.unionVariantHint,
        'Matched union variant from hint',
        'unionMatch',
      );
      return coerced;
    }
  }

  let bestResult:
    | {
        value: unknown;
        score: number;
        corrections: Correction[];
        index: number;
      }
    | undefined;

  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const testCtx = createContext(ctx.partial, ctx.visited, ctx.depth);
    const coerced = coerceValue(value, option, testCtx);

    if (testCtx.errors.length === 0) {
      const score = totalScore(testCtx.corrections);

      if (score === 0) {
        ctx.corrections.push(...testCtx.corrections);
        addCorrection(ctx, i, i, 'Matched union variant', 'unionMatch');
        return coerced;
      }

      if (!bestResult || score < bestResult.score) {
        bestResult = {
          value: coerced,
          score,
          corrections: testCtx.corrections,
          index: i,
        };
      }
    }
  }

  if (bestResult) {
    ctx.corrections.push(...bestResult.corrections);
    addCorrection(
      ctx,
      bestResult.index,
      bestResult.index,
      'Matched union variant (with coercions)',
      'unionMatch',
    );
    return bestResult.value;
  }

  addError(ctx, 'union', value, 'Value does not match any union member');
  return ctx.partial ? undefined : value;
}

export function coerceDiscriminatedUnion(
  value: unknown,
  schema: z.ZodDiscriminatedUnion<
    string,
    z.ZodDiscriminatedUnionOption<string>[]
  >,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown {
  if (typeof value !== 'object' || value === null) {
    addError(
      ctx,
      'discriminated_union',
      value,
      'Expected object for discriminated union',
    );
    return ctx.partial ? undefined : value;
  }

  const discriminator = schema.discriminator;
  const inputObj = value as Record<string, unknown>;
  const discriminatorValue = inputObj[discriminator];

  if (discriminatorValue === undefined) {
    if (ctx.partial) return undefined;
    addError(
      ctx,
      'discriminated_union',
      value,
      `Missing discriminator field "${discriminator}"`,
    );
    return value;
  }

  const optionsMap = schema.optionsMap;
  let matchedSchema = optionsMap.get(discriminatorValue as string);

  if (!matchedSchema && typeof discriminatorValue === 'string') {
    const entries = Array.from(optionsMap.entries());
    for (let i = 0; i < entries.length; i++) {
      const [key, optionSchema] = entries[i];
      if (
        normalizeEnumValue(String(key)) ===
        normalizeEnumValue(discriminatorValue)
      ) {
        matchedSchema = optionSchema;
        addCorrection(
          childContext(ctx, discriminator),
          discriminatorValue,
          key,
          'Matched discriminator case-insensitively',
          'enumCaseNormalized',
        );
        (inputObj as Record<string, unknown>)[discriminator] = key;
        break;
      }
    }
  }

  if (!matchedSchema) {
    addError(
      ctx,
      `discriminated_union(${discriminator})`,
      discriminatorValue,
      `Invalid discriminator value "${discriminatorValue}"`,
    );
    return ctx.partial ? undefined : value;
  }

  return coerceValue(value, matchedSchema, ctx);
}

export function coerceIntersection(
  value: unknown,
  schema: z.ZodIntersection<z.ZodType, z.ZodType>,
  ctx: CoercionContext,
  coerceValue: CoerceValueFn,
): unknown {
  const left = schema._def.left;
  const right = schema._def.right;

  const leftCtx = createContext(ctx.partial, ctx.visited, ctx.depth);
  const rightCtx = createContext(ctx.partial, ctx.visited, ctx.depth);

  const leftResult = coerceValue(value, left, leftCtx);
  const rightResult = coerceValue(value, right, rightCtx);

  ctx.corrections.push(...leftCtx.corrections, ...rightCtx.corrections);

  if (leftCtx.errors.length > 0 || rightCtx.errors.length > 0) {
    ctx.errors.push(...leftCtx.errors, ...rightCtx.errors);
  }

  if (
    typeof leftResult === 'object' &&
    leftResult !== null &&
    typeof rightResult === 'object' &&
    rightResult !== null &&
    !Array.isArray(leftResult) &&
    !Array.isArray(rightResult)
  ) {
    return { ...leftResult, ...rightResult };
  }

  return rightResult ?? leftResult;
}
