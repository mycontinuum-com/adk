import type { z } from 'zod';
import type { ParseResult } from './types';
import {
  createParser as _createParser,
  type SchemaAwareParser,
} from './parser';

export { createParser, type SchemaAwareParser } from './parser';

export function parse<T>(input: string, schema: z.ZodType<T>): ParseResult<T> {
  const parser = _createParser(schema);
  return parser.parse(input);
}

export function parsePartial<T>(
  input: string,
  schema: z.ZodType<T>,
): ParseResult<Partial<T>> {
  const parser = _createParser(schema);
  return parser.parsePartial(input);
}

export {
  parseJsonish,
  parsePartialJson,
  extractJsonFromText,
  parseWithFixingParser,
  getPositionFromOffset,
  type JsonishResult,
  type ParseOptions,
} from './jsonish';

export { coerce, coercePartial, coerceFromJsonish } from './coercion/index';

export {
  createStreamParser,
  parseStreamChunks,
  type StreamParser,
  type StreamDelta,
  type StreamResult,
} from './streaming';

export type {
  CompletionState,
  JsonishFix,
  JsonishValue,
  JsonishPrimitive,
  JsonishObject,
  JsonishArray,
  JsonishAnyOf,
  JsonishFixed,
  JsonishMarkdown,
  CorrectionType,
  Correction,
  CoercionError,
  CoercionResult,
  CoercionSuccess,
  CoercionFailure,
  ParseResult,
  ParseResultSuccess,
  ParseResultFailure,
  ParseError,
  StreamParseState,
  SchemaType,
  ParserConfig,
} from './types';

export {
  CorrectionScores,
  DEFAULT_CONFIG,
  jsonishToPlain,
  getCompletionState,
  simplifyJsonish,
} from './types';
