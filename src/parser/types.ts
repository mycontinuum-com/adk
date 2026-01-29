import { z } from 'zod';

export type CompletionState = 'complete' | 'incomplete' | 'pending';

export interface JsonishFix {
  type:
    | 'trailing_comma'
    | 'unquoted_key'
    | 'single_quote'
    | 'comment_removed'
    | 'newline_in_string'
    | 'bare_value'
    | 'bracket_closed'
    | 'string_closed'
    | 'grepped_json'
    | 'markdown_extracted';
  description?: string;
}

export type JsonishValue =
  | JsonishPrimitive
  | JsonishObject
  | JsonishArray
  | JsonishAnyOf
  | JsonishFixed
  | JsonishMarkdown;

export interface JsonishPrimitive {
  type: 'string' | 'number' | 'boolean' | 'null';
  value: string | number | boolean | null;
  completionState: CompletionState;
}

export interface JsonishObject {
  type: 'object';
  entries: Array<{ key: string; value: JsonishValue }>;
  completionState: CompletionState;
}

export interface JsonishArray {
  type: 'array';
  items: JsonishValue[];
  completionState: CompletionState;
}

export interface JsonishAnyOf {
  type: 'anyOf';
  candidates: JsonishValue[];
  originalString: string;
}

export interface JsonishFixed {
  type: 'fixed';
  value: JsonishValue;
  fixes: JsonishFix[];
}

export interface JsonishMarkdown {
  type: 'markdown';
  tag: string;
  value: JsonishValue;
  completionState: CompletionState;
}

export const CorrectionScores = {
  optionalDefaultFromNoValue: 1,
  defaultFromNoValue: 100,
  defaultButHadValue: 110,
  singleToArray: 1,
  arrayToSet: 1,
  stringToNumber: 1,
  numberToString: 1,
  booleanToString: 1,
  numberToBigInt: 1,
  stringToBigInt: 1,
  stringToBool: 1,
  numberToBool: 1,
  booleanToNumber: 1,
  stringToNull: 1,
  stringToFloat: 1,
  stringToDate: 1,
  numberToDate: 1,
  floatToInt: 1,
  enumCaseNormalized: 1,
  enumPrefixMatch: 2,
  enumSubstringMatch: 2,
  enumAccentNormalized: 1,
  keyCaseNormalized: 1,
  keyUnderscoreMatch: 1,
  jsonToString: 2,
  objectToString: 2,
  objectToPrimitive: 2,
  objectToMap: 1,
  arrayItemParseError: 1,
  mapKeyParseError: 1,
  mapValueParseError: 1,
  firstMatch: 1,
  unionMatch: 0,
  extraKey: 1,
  impliedKey: 2,
  noFields: 1,
  substringMatch: 2,
  strippedNonAlphanumeric: 3,
  commaSeparatedToArray: 1,
  urlProtocolAdded: 1,
  fractionParsed: 1,
  currencyStripped: 1,
  incomplete: 0,
  pending: 0,
  inferedObject: 5,
  objectFromMarkdown: 1,
  objectFromFixedJson: 1,
  anyOfFirstCandidate: 1,
} as const;

export const NESTED_SCORE_MULTIPLIER = 10;

export type CorrectionType = keyof typeof CorrectionScores;

export interface Correction {
  path: string[];
  from: unknown;
  to: unknown;
  reason: string;
  type: CorrectionType;
  score: number;
}

export interface CoercionError {
  path: string[];
  expected: string;
  received: unknown;
  message: string;
}

export interface CoercionSuccess<T> {
  success: true;
  value: T;
  corrections: Correction[];
  totalScore: number;
}

export interface CoercionFailure<T> {
  success: false;
  errors: CoercionError[];
  partial?: Partial<T>;
  corrections: Correction[];
  totalScore: number;
}

export type CoercionResult<T> = CoercionSuccess<T> | CoercionFailure<T>;

export interface ParseResultSuccess<T> {
  success: true;
  value: T;
  raw?: unknown;
  jsonish?: JsonishValue;
  errors: ParseError[];
  corrections: Correction[];
  totalScore: number;
}

export interface ParseResultFailure<T> {
  success: false;
  partial?: Partial<T>;
  raw?: unknown;
  jsonish?: JsonishValue;
  errors: ParseError[];
  corrections: Correction[];
  totalScore: number;
}

export type ParseResult<T> = ParseResultSuccess<T> | ParseResultFailure<T>;

export interface ParseError {
  stage: 'extraction' | 'json' | 'coercion' | 'validation';
  message: string;
  path?: string[];
  position?: { line: number; column: number; offset?: number };
}

export interface StreamParseState<T> {
  buffer: string;
  current: Partial<T> | undefined;
  currentJsonish: JsonishValue | undefined;
  complete: boolean;
  errors: ParseError[];
  completionStates: Map<string, CompletionState>;
}

export type SchemaType = z.ZodType;

export interface ParserConfig {
  extractFromMarkdown?: boolean;
  coerceTypes?: boolean;
}

export const DEFAULT_CONFIG: Required<ParserConfig> = {
  extractFromMarkdown: true,
  coerceTypes: true,
};

export function jsonishToPlain(value: JsonishValue): unknown {
  switch (value.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return value.value;
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const { key, value: v } of value.entries) {
        obj[key] = jsonishToPlain(v);
      }
      return obj;
    }
    case 'array':
      return value.items.map(jsonishToPlain);
    case 'anyOf':
      return value.candidates.length > 0
        ? jsonishToPlain(value.candidates[0])
        : null;
    case 'fixed':
      return jsonishToPlain(value.value);
    case 'markdown':
      return jsonishToPlain(value.value);
  }
}

export function getCompletionState(value: JsonishValue): CompletionState {
  switch (value.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'object':
    case 'array':
    case 'markdown':
      return value.completionState;
    case 'anyOf':
      for (const candidate of value.candidates) {
        if (getCompletionState(candidate) === 'incomplete') {
          return 'incomplete';
        }
      }
      return 'complete';
    case 'fixed':
      return getCompletionState(value.value);
  }
}

export function simplifyJsonish(
  value: JsonishValue,
  isDone: boolean,
): JsonishValue {
  if (value.type !== 'anyOf') return value;

  const simplified = value.candidates.map((c) => simplifyJsonish(c, isDone));

  if (simplified.length === 0) {
    return {
      type: 'string',
      value: value.originalString,
      completionState: isDone ? 'complete' : 'incomplete',
    };
  }

  if (simplified.length === 1) {
    const single = simplified[0];
    if (single.type === 'string' && single.value === value.originalString) {
      return {
        type: 'string',
        value: value.originalString,
        completionState: isDone ? 'complete' : 'incomplete',
      };
    }
    return { ...value, candidates: simplified };
  }

  return { ...value, candidates: simplified };
}
