import type { ZodSchema } from '../types/zod'
import type { ParseResult } from './types'

import { createParser as _createParser } from './parser'

export { createParser, type SchemaAwareParser } from './parser'

export function parse<T>(input: string, schema: ZodSchema<T>): ParseResult<T> {
  const parser = _createParser(schema)
  return parser.parse(input)
}

export function parsePartial<T>(input: string, schema: ZodSchema<T>): ParseResult<Partial<T>> {
  const parser = _createParser(schema)
  return parser.parsePartial(input)
}

export {
  parseJsonish,
  parsePartialJson,
  extractJsonFromText,
  getPositionFromOffset,
  type JsonishResult,
} from './jsonish'

export { coerce, coercePartial } from './coercion/index'

export {
  createStreamParser,
  parseStreamChunks,
  type StreamParser,
  type StreamResult,
} from './streaming'

export type {
  Correction,
  CoercionError,
  CoercionResult,
  ParseResult,
  ParseError,
  StreamParseState,
  ParserConfig,
} from './types'
