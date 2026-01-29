import type { z } from 'zod';
import type {
  ParseResult,
  ParseResultSuccess,
  ParseResultFailure,
  ParserConfig,
  ParseError,
  CoercionError,
  Correction,
  JsonishValue,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { parseJsonish, getPositionFromOffset } from './jsonish';
import { coerce, coerceFromJsonish } from './coercion/index';

const JSON_ERROR_POSITION_REGEX = /position\s+(\d+)/i;

export interface SchemaAwareParser<T> {
  parse(input: string): ParseResult<T>;
  parsePartial(input: string): ParseResult<Partial<T>>;
  validate(value: unknown): ParseResult<T>;
  schema: z.ZodType<T>;
}

function coercionErrorsToParseErrors(errors: CoercionError[]): ParseError[] {
  return errors.map((e) => ({
    stage: 'coercion' as const,
    message: e.message,
    path: e.path,
  }));
}

function makeSuccessResult<T>(
  value: T,
  raw: unknown,
  corrections: Correction[],
  totalScore: number,
  jsonish?: JsonishValue,
): ParseResultSuccess<T> {
  return {
    success: true,
    value,
    raw,
    jsonish,
    errors: [],
    corrections,
    totalScore,
  };
}

function makeFailureResult<T>(
  errors: ParseError[],
  corrections: Correction[] = [],
  totalScore: number = Infinity,
  partial?: Partial<T>,
  raw?: unknown,
  jsonish?: JsonishValue,
): ParseResultFailure<T> {
  return {
    success: false,
    partial,
    raw,
    jsonish,
    errors,
    corrections,
    totalScore,
  };
}

export function createParser<T>(
  schema: z.ZodType<T>,
  config: ParserConfig = {},
): SchemaAwareParser<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  function parseWithCoercion(
    raw: unknown,
    jsonish: JsonishValue | undefined,
    partial: true,
  ): ParseResult<Partial<T>>;
  function parseWithCoercion(
    raw: unknown,
    jsonish: JsonishValue | undefined,
    partial: false,
  ): ParseResult<T>;
  function parseWithCoercion(
    raw: unknown,
    jsonish: JsonishValue | undefined,
    partial: boolean,
  ): ParseResult<T> | ParseResult<Partial<T>> {
    const result = jsonish
      ? coerceFromJsonish<T>(jsonish, schema, { partial })
      : coerce<T>(raw, schema, { partial });

    if (result.success) {
      return makeSuccessResult(
        result.value,
        raw,
        result.corrections,
        result.totalScore,
        jsonish,
      );
    }

    const failure = result as {
      success: false;
      partial?: Partial<T>;
      errors: CoercionError[];
    };
    if (partial) {
      return makeSuccessResult(
        (failure.partial ?? {}) as Partial<T>,
        raw,
        result.corrections,
        result.totalScore,
        jsonish,
      );
    }
    return makeFailureResult(
      coercionErrorsToParseErrors(failure.errors),
      result.corrections,
      result.totalScore,
      failure.partial,
      raw,
      jsonish,
    );
  }

  function parseWithValidation(
    raw: unknown,
    jsonish?: JsonishValue,
  ): ParseResult<T> {
    const validation = schema.safeParse(raw);
    if (validation.success) {
      return makeSuccessResult(validation.data, raw, [], 0, jsonish);
    }
    return makeFailureResult(
      validation.error.errors.map((e) => ({
        stage: 'validation' as const,
        message: e.message,
        path: e.path.map(String),
      })),
      [],
      Infinity,
      undefined,
      raw,
      jsonish,
    );
  }

  return {
    schema,

    parse(input: string): ParseResult<T> {
      if (cfg.extractFromMarkdown) {
        const jsonishResult = parseJsonish(input, { extractFromText: true });
        if (!jsonishResult.success || !jsonishResult.jsonish) {
          return makeFailureResult(jsonishResult.errors);
        }
        return cfg.coerceTypes
          ? parseWithCoercion(jsonishResult.value, jsonishResult.jsonish, false)
          : parseWithValidation(jsonishResult.value, jsonishResult.jsonish);
      }

      try {
        const parsed = JSON.parse(input);
        return cfg.coerceTypes
          ? parseWithCoercion(parsed, undefined, false)
          : parseWithValidation(parsed);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Invalid JSON';
        const error: ParseError = { stage: 'json', message };

        const posMatch = message.match(JSON_ERROR_POSITION_REGEX);
        if (posMatch) {
          const offset = parseInt(posMatch[1], 10);
          const pos = getPositionFromOffset(input, offset);
          error.position = { ...pos, offset };
        }

        return makeFailureResult([error]);
      }
    },

    parsePartial(input: string): ParseResult<Partial<T>> {
      const jsonishResult = parseJsonish(input, {
        extractFromText: cfg.extractFromMarkdown,
      });

      if (!jsonishResult.success || !jsonishResult.jsonish) {
        return makeFailureResult(jsonishResult.errors);
      }

      return parseWithCoercion(
        jsonishResult.value,
        jsonishResult.jsonish,
        true,
      );
    },

    validate(value: unknown): ParseResult<T> {
      return cfg.coerceTypes
        ? parseWithCoercion(value, undefined, false)
        : parseWithValidation(value);
    },
  };
}
