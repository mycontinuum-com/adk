import type { z } from 'zod';
import type {
  ParseResult,
  StreamParseState,
  ParseError,
  JsonishValue,
  CompletionState,
  Correction,
} from './types';
import { jsonishToPlain, getCompletionState } from './types';
import { parsePartialJson, parseJsonish, extractJsonFromText } from './jsonish';
import { coerceFromJsonish } from './coercion/index';

export interface StreamResult<T> {
  partial?: Partial<T>;
  delta?: StreamDelta<T>[];
  complete: boolean;
  corrections: Correction[];
}

export interface StreamParser<T> {
  push(chunk: string): StreamResult<T>;
  getState(): StreamParseState<T>;
  getResult(): ParseResult<T>;
  finish(): StreamResult<T>;
  isDone(): boolean;
  reset(): void;
}

export interface StreamDelta<T> {
  path: string[];
  value: unknown;
  operation: 'set' | 'append' | 'delete' | 'complete';
}

interface StreamContext<T> {
  buffer: string;
  lastParsedValue: JsonishValue | undefined;
  lastCoercedValue: Partial<T> | undefined;
  completionStates: Map<string, CompletionState>;
  errors: ParseError[];
  complete: boolean;
}

function computeDeltas<T>(
  oldValue: JsonishValue | undefined,
  newValue: JsonishValue | undefined,
  path: string[] = [],
): StreamDelta<T>[] {
  if (!newValue) return [];
  if (!oldValue) {
    return [
      {
        path,
        value: jsonishToPlain(newValue),
        operation: 'set',
      },
    ];
  }

  const deltas: StreamDelta<T>[] = [];

  if (oldValue.type !== newValue.type) {
    return [
      {
        path,
        value: jsonishToPlain(newValue),
        operation: 'set',
      },
    ];
  }

  switch (newValue.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null': {
      const oldPrimitive = oldValue as typeof newValue;
      if (oldPrimitive.value !== newValue.value) {
        if (
          newValue.type === 'string' &&
          oldValue.type === 'string' &&
          (newValue.value as string).startsWith(oldPrimitive.value as string)
        ) {
          const appendedContent = (newValue.value as string).slice(
            (oldPrimitive.value as string).length,
          );
          if (appendedContent) {
            deltas.push({ path, value: appendedContent, operation: 'append' });
          }
        } else {
          deltas.push({ path, value: newValue.value, operation: 'set' });
        }
      }
      if (
        oldPrimitive.completionState !== newValue.completionState &&
        newValue.completionState === 'complete'
      ) {
        deltas.push({ path, value: newValue.value, operation: 'complete' });
      }
      break;
    }

    case 'object': {
      const oldObj = oldValue as typeof newValue;
      const oldKeysObj: Record<string, number> = {};
      oldObj.entries.forEach((e, i) => {
        oldKeysObj[e.key] = i;
      });
      const newKeysObj: Record<string, number> = {};
      newValue.entries.forEach((e, i) => {
        newKeysObj[e.key] = i;
      });

      for (const key of Object.keys(newKeysObj)) {
        const newIdx = newKeysObj[key];
        const newEntry = newValue.entries[newIdx];
        const oldIdx = oldKeysObj[key];

        if (oldIdx === undefined) {
          deltas.push({
            path: [...path, key],
            value: jsonishToPlain(newEntry.value),
            operation: 'set',
          });
        } else {
          const oldEntry = oldObj.entries[oldIdx];
          deltas.push(
            ...computeDeltas<T>(oldEntry.value, newEntry.value, [...path, key]),
          );
        }
      }

      for (const key of Object.keys(oldKeysObj)) {
        if (!(key in newKeysObj)) {
          deltas.push({
            path: [...path, key],
            value: undefined,
            operation: 'delete',
          });
        }
      }

      if (
        oldObj.completionState !== newValue.completionState &&
        newValue.completionState === 'complete'
      ) {
        deltas.push({
          path,
          value: jsonishToPlain(newValue),
          operation: 'complete',
        });
      }
      break;
    }

    case 'array': {
      const oldArr = oldValue as typeof newValue;
      const minLen = Math.min(oldArr.items.length, newValue.items.length);

      for (let i = 0; i < minLen; i++) {
        deltas.push(
          ...computeDeltas<T>(oldArr.items[i], newValue.items[i], [
            ...path,
            String(i),
          ]),
        );
      }

      for (let i = minLen; i < newValue.items.length; i++) {
        deltas.push({
          path: [...path, String(i)],
          value: jsonishToPlain(newValue.items[i]),
          operation: 'set',
        });
      }

      if (
        oldArr.completionState !== newValue.completionState &&
        newValue.completionState === 'complete'
      ) {
        deltas.push({
          path,
          value: jsonishToPlain(newValue),
          operation: 'complete',
        });
      }
      break;
    }

    case 'fixed':
    case 'markdown': {
      const oldInner =
        oldValue.type === 'fixed'
          ? (oldValue as typeof newValue).value
          : (oldValue as { type: 'markdown'; value: JsonishValue }).value;
      const newInner =
        newValue.type === 'fixed'
          ? newValue.value
          : (newValue as { type: 'markdown'; value: JsonishValue }).value;
      deltas.push(...computeDeltas<T>(oldInner, newInner, path));
      break;
    }

    case 'anyOf': {
      if (
        oldValue.type === 'anyOf' &&
        oldValue.candidates.length > 0 &&
        newValue.candidates.length > 0
      ) {
        deltas.push(
          ...computeDeltas<T>(
            oldValue.candidates[0],
            newValue.candidates[0],
            path,
          ),
        );
      } else {
        deltas.push({
          path,
          value: jsonishToPlain(newValue),
          operation: 'set',
        });
      }
      break;
    }
  }

  return deltas;
}

function getCompletionStatesRecursive(
  value: JsonishValue | undefined,
  path: string[] = [],
  states: Map<string, CompletionState> = new Map(),
): Map<string, CompletionState> {
  if (!value) return states;

  const pathKey = path.join('.');
  const state = getCompletionState(value);
  states.set(pathKey || '$root', state);

  switch (value.type) {
    case 'object':
      for (const entry of value.entries) {
        getCompletionStatesRecursive(entry.value, [...path, entry.key], states);
      }
      break;
    case 'array':
      for (let i = 0; i < value.items.length; i++) {
        getCompletionStatesRecursive(
          value.items[i],
          [...path, String(i)],
          states,
        );
      }
      break;
    case 'fixed':
      getCompletionStatesRecursive(value.value, path, states);
      break;
    case 'markdown':
      getCompletionStatesRecursive(value.value, path, states);
      break;
    case 'anyOf':
      if (value.candidates.length > 0) {
        getCompletionStatesRecursive(value.candidates[0], path, states);
      }
      break;
  }

  return states;
}

export function createStreamParser<T>(
  schema: z.ZodType<T>,
  options: { extractFromMarkdown?: boolean } = {},
): StreamParser<T> {
  const { extractFromMarkdown = true } = options;

  const ctx: StreamContext<T> = {
    buffer: '',
    lastParsedValue: undefined,
    lastCoercedValue: undefined,
    completionStates: new Map(),
    errors: [],
    complete: false,
  };

  let lastCorrections: Correction[] = [];
  let lastDeltas: StreamDelta<T>[] = [];

  const doParse = (): void => {
    if (!ctx.buffer.trim()) return;

    let content = ctx.buffer;
    if (extractFromMarkdown) {
      content = extractJsonFromText(content);
    }

    const result = parsePartialJson(content, { extractFromText: false });

    if (result.success && result.jsonish) {
      const prevValue = ctx.lastParsedValue;
      ctx.lastParsedValue = result.jsonish;
      ctx.completionStates = getCompletionStatesRecursive(result.jsonish);
      lastDeltas = computeDeltas<T>(prevValue, result.jsonish);

      const coerceResult = coerceFromJsonish<T>(result.jsonish, schema, {
        partial: true,
      });
      if (coerceResult.success) {
        ctx.lastCoercedValue = coerceResult.value as Partial<T>;
        lastCorrections = coerceResult.corrections;
      } else {
        const failure = coerceResult as {
          success: false;
          partial?: Partial<T>;
        };
        if (failure.partial) {
          ctx.lastCoercedValue = failure.partial;
        }
        lastCorrections = coerceResult.corrections;
      }
      ctx.errors = [];
    } else {
      ctx.errors = result.errors;
    }
  };

  return {
    push(chunk: string): StreamResult<T> {
      ctx.buffer += chunk;
      doParse();
      return {
        partial: ctx.lastCoercedValue,
        delta: lastDeltas,
        complete: ctx.complete,
        corrections: lastCorrections,
      };
    },

    getState(): StreamParseState<T> {
      return {
        buffer: ctx.buffer,
        current: ctx.lastCoercedValue,
        currentJsonish: ctx.lastParsedValue,
        complete: ctx.complete,
        errors: ctx.errors,
        completionStates: ctx.completionStates,
      };
    },

    getResult(): ParseResult<T> {
      const finalResult = parseJsonish(ctx.buffer, {
        extractFromText: extractFromMarkdown,
      });

      if (!finalResult.success || !finalResult.jsonish) {
        return {
          success: false,
          errors: finalResult.errors,
          corrections: [],
          totalScore: Infinity,
        };
      }

      const coerceResult = coerceFromJsonish<T>(finalResult.jsonish, schema);
      ctx.complete = true;

      if (coerceResult.success) {
        return {
          success: true,
          value: coerceResult.value,
          raw: finalResult.value,
          jsonish: finalResult.jsonish,
          errors: [],
          corrections: coerceResult.corrections,
          totalScore: coerceResult.totalScore,
        };
      }

      const failure = coerceResult as {
        success: false;
        partial?: Partial<T>;
        errors: Array<{ message: string; path: string[] }>;
      };
      return {
        success: false,
        partial: failure.partial,
        raw: finalResult.value,
        jsonish: finalResult.jsonish,
        errors: failure.errors.map((e) => ({
          stage: 'coercion',
          message: e.message,
          path: e.path,
        })),
        corrections: coerceResult.corrections,
        totalScore: coerceResult.totalScore,
      };
    },

    finish(): StreamResult<T> {
      const finalResult = parseJsonish(ctx.buffer, {
        extractFromText: extractFromMarkdown,
      });

      if (!finalResult.success || !finalResult.jsonish) {
        return {
          partial: ctx.lastCoercedValue,
          complete: false,
          corrections: lastCorrections,
        };
      }

      const coerceResult = coerceFromJsonish<T>(finalResult.jsonish, schema);
      ctx.complete = coerceResult.success;

      if (coerceResult.success) {
        ctx.lastCoercedValue = coerceResult.value as Partial<T>;
      } else {
        const failure = coerceResult as {
          success: false;
          partial?: Partial<T>;
        };
        if (failure.partial) {
          ctx.lastCoercedValue = failure.partial;
        }
      }

      return {
        partial: ctx.lastCoercedValue,
        complete: coerceResult.success,
        corrections: coerceResult.corrections,
      };
    },

    isDone(): boolean {
      const rootState = ctx.completionStates.get('$root');
      return rootState === 'complete';
    },

    reset(): void {
      ctx.buffer = '';
      ctx.lastParsedValue = undefined;
      ctx.lastCoercedValue = undefined;
      ctx.completionStates = new Map();
      ctx.errors = [];
      ctx.complete = false;
      lastCorrections = [];
      lastDeltas = [];
    },
  };
}

export function parseStreamChunks<T>(
  schema: z.ZodType<T>,
  chunks: string[],
): ParseResult<T> {
  const parser = createStreamParser(schema);

  for (const chunk of chunks) {
    parser.push(chunk);
  }

  return parser.getResult();
}
