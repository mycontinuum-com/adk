import type { ParseError, JsonishValue, CompletionState } from '../types';
import { jsonishToPlain } from '../types';
import { parseWithFixingParser } from './state-machine';
import {
  extractJsonFromText,
  extractBalancedJsonObjects,
  getPositionFromOffset,
} from './extractors';

export { parseWithFixingParser } from './state-machine';
export { extractJsonFromText, getPositionFromOffset } from './extractors';

export interface JsonishResult {
  success: boolean;
  value?: unknown;
  jsonish?: JsonishValue;
  errors: ParseError[];
  fallback?: boolean;
}

export interface ParseOptions {
  extractFromText?: boolean;
  partial?: boolean;
}

function plainToJsonish(
  value: unknown,
  completionState: CompletionState,
): JsonishValue {
  if (value === null) return { type: 'null', value: null, completionState };
  if (typeof value === 'string')
    return { type: 'string', value, completionState };
  if (typeof value === 'number')
    return { type: 'number', value, completionState };
  if (typeof value === 'boolean')
    return { type: 'boolean', value, completionState };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.map((v) => plainToJsonish(v, completionState)),
      completionState,
    };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      entries: Object.entries(value as Record<string, unknown>).map(
        ([k, v]) => ({
          key: k,
          value: plainToJsonish(v, completionState),
        }),
      ),
      completionState,
    };
  }
  return { type: 'null', value: null, completionState };
}

export function parseJsonish(
  text: string,
  options: { extractFromText?: boolean } = {},
): JsonishResult {
  const { extractFromText = true } = options;

  let content = text;
  if (extractFromText) {
    content = extractJsonFromText(content);
  }

  try {
    const parsed = JSON.parse(content);
    const jsonish = plainToJsonish(parsed, 'complete');
    return { success: true, value: parsed, jsonish, errors: [] };
  } catch {
    // Continue to lenient parsing
  }

  const balancedObjects = extractBalancedJsonObjects(content);
  if (balancedObjects.length > 1) {
    const candidates: JsonishValue[] = [];
    for (const obj of balancedObjects) {
      try {
        const parsed = JSON.parse(obj);
        candidates.push(plainToJsonish(parsed, 'complete'));
      } catch {
        const result = parseWithFixingParser(obj);
        if (result.values.length > 0) {
          candidates.push(result.values[0].value);
        }
      }
    }
    if (candidates.length > 1) {
      const anyOf: JsonishValue = {
        type: 'anyOf',
        candidates,
        originalString: content,
      };
      return {
        success: true,
        value: jsonishToPlain(candidates[0]),
        jsonish: anyOf,
        errors: [],
      };
    }
  }

  const result = parseWithFixingParser(content);

  if (result.values.length > 0) {
    const { value, fixes } = result.values[0];
    const jsonish: JsonishValue =
      fixes.length > 0 ? { type: 'fixed', value, fixes } : value;
    return {
      success: true,
      value: jsonishToPlain(value),
      jsonish,
      errors: [],
    };
  }

  return {
    success: true,
    value: content,
    jsonish: { type: 'string', value: content, completionState: 'incomplete' },
    errors: [],
    fallback: true,
  };
}

export function parsePartialJson(
  text: string,
  options: { extractFromText?: boolean } = {},
): JsonishResult {
  const { extractFromText = true } = options;
  let content = extractFromText
    ? extractJsonFromText(text.trim())
    : text.trim();

  try {
    const parsed = JSON.parse(content);
    const jsonish = plainToJsonish(parsed, 'complete');
    return { success: true, value: parsed, jsonish, errors: [] };
  } catch {
    // Continue to partial parsing
  }

  const result = parseWithFixingParser(content);

  if (result.values.length > 0) {
    const { value, fixes } = result.values[0];
    const jsonish: JsonishValue =
      fixes.length > 0 ? { type: 'fixed', value, fixes } : value;
    return {
      success: true,
      value: jsonishToPlain(value),
      jsonish,
      errors: [],
    };
  }

  return {
    success: false,
    errors: [{ stage: 'json', message: 'Failed to parse partial JSON' }],
  };
}
