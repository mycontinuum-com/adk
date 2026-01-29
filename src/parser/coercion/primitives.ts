import { z } from 'zod';
import type { CoercionContext } from './context';
import { addCorrection, addError } from './context';

const URL_PROTOCOL_REGEX = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
const CURRENCY_REGEX = /[\p{Sc}]/gu;
const COMMA_REGEX = /,/g;
const TRAILING_COMMA_REGEX = /,$/g;
const NUMERIC_PARTS_REGEX = /^([+-])?(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(%)?$/;
const PERCENT_REGEX = /^(-?\d+(?:\.\d+)?)\s*%$/;
const LEADING_NUMBER_REGEX = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

export function coerceToString(
  value: unknown,
  ctx: CoercionContext,
): string | undefined {
  if (typeof value === 'string') return value;

  if (value === null || value === undefined) {
    if (ctx.partial) return undefined;
    addError(ctx, 'string', value, 'Expected string but got null/undefined');
    return undefined;
  }

  if (typeof value === 'number') {
    const result = String(value);
    addCorrection(
      ctx,
      value,
      result,
      'Coerced number to string',
      'numberToString',
    );
    return result;
  }

  if (typeof value === 'boolean') {
    const result = String(value);
    addCorrection(
      ctx,
      value,
      result,
      'Coerced boolean to string',
      'booleanToString',
    );
    return result;
  }

  if (Array.isArray(value) && value.length === 1) {
    const item = value[0];
    if (typeof item === 'string') {
      addCorrection(
        ctx,
        value,
        item,
        'Unwrapped single-element array to string',
        'singleToArray',
      );
      return item;
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    try {
      const result = JSON.stringify(value);
      addCorrection(
        ctx,
        value,
        result,
        'Converted object to JSON string',
        'objectToString',
      );
      return result;
    } catch {
      addError(ctx, 'string', value, 'Cannot stringify object');
      return undefined;
    }
  }

  addError(ctx, 'string', value, `Cannot coerce ${typeof value} to string`);
  return undefined;
}

export function applyStringRefinements(
  value: string,
  schema: z.ZodType,
  ctx: CoercionContext,
): string {
  if (!(schema instanceof z.ZodString)) return value;

  const checks =
    (schema._def as { checks?: Array<{ kind: string }> }).checks || [];

  for (const check of checks) {
    if (check.kind === 'url') {
      if (value && !URL_PROTOCOL_REGEX.test(value)) {
        const fixed = `https://${value}`;
        addCorrection(
          ctx,
          value,
          fixed,
          'Added https:// protocol to URL',
          'urlProtocolAdded',
        );
        return fixed;
      }
    }
  }

  return value;
}

export function coerceToBigInt(
  value: unknown,
  ctx: CoercionContext,
): bigint | undefined {
  if (typeof value === 'bigint') return value;

  if (value === null || value === undefined) {
    if (ctx.partial) return undefined;
    addError(ctx, 'bigint', value, 'Expected bigint but got null/undefined');
    return undefined;
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    const result = BigInt(value);
    addCorrection(
      ctx,
      value,
      result,
      'Coerced number to bigint',
      'numberToBigInt',
    );
    return result;
  }

  if (typeof value === 'string') {
    try {
      const trimmed = value.trim();
      const result = BigInt(trimmed);
      addCorrection(
        ctx,
        value,
        result,
        'Coerced string to bigint',
        'stringToBigInt',
      );
      return result;
    } catch {
      addError(ctx, 'bigint', value, 'Cannot parse string as bigint');
      return undefined;
    }
  }

  addError(ctx, 'bigint', value, `Cannot coerce ${typeof value} to bigint`);
  return undefined;
}

function parseFraction(value: string): number | undefined {
  const parts = value.split('/');
  if (parts.length !== 2) return undefined;

  const num = parseFloat(parts[0].trim());
  const denom = parseFloat(parts[1].trim());

  if (Number.isNaN(num) || Number.isNaN(denom) || denom === 0) return undefined;
  return num / denom;
}

function stripCurrencyAndParse(value: string): number | undefined {
  const stripped = value.replace(CURRENCY_REGEX, '').trim();

  const withoutCommas = stripped.replace(COMMA_REGEX, '');

  const match = withoutCommas.match(NUMERIC_PARTS_REGEX);
  if (match) {
    const num = parseFloat((match[1] || '') + match[2]);
    return Number.isNaN(num) ? undefined : num;
  }

  return undefined;
}

export function coerceToNumber(
  value: unknown,
  ctx: CoercionContext,
): number | undefined {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;

  if (value === null || value === undefined) {
    if (ctx.partial) return undefined;
    addError(ctx, 'number', value, 'Expected number but got null/undefined');
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().replace(TRAILING_COMMA_REGEX, '');

    const direct = Number(trimmed);
    if (!Number.isNaN(direct)) {
      addCorrection(
        ctx,
        value,
        direct,
        'Coerced string to number',
        'stringToNumber',
      );
      return direct;
    }

    const withoutCommas = trimmed.replace(COMMA_REGEX, '');
    const parsedWithoutCommas = Number(withoutCommas);
    if (!Number.isNaN(parsedWithoutCommas)) {
      addCorrection(
        ctx,
        value,
        parsedWithoutCommas,
        'Coerced string to number (removed commas)',
        'stringToNumber',
      );
      return parsedWithoutCommas;
    }

    const fraction = parseFraction(trimmed);
    if (fraction !== undefined) {
      addCorrection(
        ctx,
        value,
        fraction,
        'Parsed fraction to number',
        'fractionParsed',
      );
      return fraction;
    }

    const currencyParsed = stripCurrencyAndParse(trimmed);
    if (currencyParsed !== undefined) {
      addCorrection(
        ctx,
        value,
        currencyParsed,
        'Stripped currency symbol and parsed number',
        'currencyStripped',
      );
      return currencyParsed;
    }

    const percentMatch = trimmed.match(PERCENT_REGEX);
    if (percentMatch) {
      const percent = Number(percentMatch[1]);
      addCorrection(
        ctx,
        value,
        percent,
        'Extracted number from percentage string',
        'stringToNumber',
      );
      return percent;
    }

    const numberMatch = trimmed.match(LEADING_NUMBER_REGEX);
    if (numberMatch) {
      const extracted = Number(numberMatch[1]);
      if (!Number.isNaN(extracted)) {
        addCorrection(
          ctx,
          value,
          extracted,
          'Extracted leading number from string',
          'stringToNumber',
        );
        return extracted;
      }
    }
  }

  if (typeof value === 'boolean') {
    const result = value ? 1 : 0;
    addCorrection(
      ctx,
      value,
      result,
      'Coerced boolean to number',
      'booleanToNumber',
    );
    return result;
  }

  addError(ctx, 'number', value, `Cannot coerce ${typeof value} to number`);
  return undefined;
}

function matchFuzzy(value: string, targets: string[]): string | undefined {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  for (const t of targets) {
    if (t === trimmed) return t;
  }

  for (const t of targets) {
    if (t.toLowerCase() === lower) return t;
  }

  return undefined;
}

export function coerceToBoolean(
  value: unknown,
  ctx: CoercionContext,
): boolean | undefined {
  if (typeof value === 'boolean') return value;

  if (value === null || value === undefined) {
    if (ctx.partial) return undefined;
    addError(ctx, 'boolean', value, 'Expected boolean but got null/undefined');
    return undefined;
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === 'yes' || lower === '1') {
      addCorrection(
        ctx,
        value,
        true,
        'Coerced string to boolean',
        'stringToBool',
      );
      return true;
    }
    if (lower === 'false' || lower === 'no' || lower === '0') {
      addCorrection(
        ctx,
        value,
        false,
        'Coerced string to boolean',
        'stringToBool',
      );
      return false;
    }

    const trueMatch = matchFuzzy(value, [
      'true',
      'True',
      'TRUE',
      'yes',
      'Yes',
      'YES',
    ]);
    if (trueMatch) {
      addCorrection(
        ctx,
        value,
        true,
        'Matched boolean string fuzzily',
        'stringToBool',
      );
      return true;
    }

    const falseMatch = matchFuzzy(value, [
      'false',
      'False',
      'FALSE',
      'no',
      'No',
      'NO',
    ]);
    if (falseMatch) {
      addCorrection(
        ctx,
        value,
        false,
        'Matched boolean string fuzzily',
        'stringToBool',
      );
      return false;
    }
  }

  if (typeof value === 'number') {
    const result = value !== 0;
    addCorrection(
      ctx,
      value,
      result,
      'Coerced number to boolean',
      'numberToBool',
    );
    return result;
  }

  addError(ctx, 'boolean', value, `Cannot coerce ${typeof value} to boolean`);
  return undefined;
}

export function coerceToDate(
  value: unknown,
  ctx: CoercionContext,
): Date | undefined {
  if (value instanceof Date) return value;

  if (value === null || value === undefined) {
    if (ctx.partial) return undefined;
    addError(ctx, 'date', value, 'Expected date but got null/undefined');
    return undefined;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      addCorrection(ctx, value, date, 'Coerced string to date', 'stringToDate');
      return date;
    }
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      addCorrection(ctx, value, date, 'Coerced number to date', 'numberToDate');
      return date;
    }
  }

  addError(ctx, 'date', value, `Cannot coerce ${typeof value} to date`);
  return undefined;
}
