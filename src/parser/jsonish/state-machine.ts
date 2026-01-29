import type { JsonishValue, JsonishFix, CompletionState } from '../types';

const WHITESPACE_REGEX = /\s/;
const LEADING_WHITESPACE_REGEX = /^(\s*)/;
const UNQUOTED_DELIMITER_REGEX = /[,}\]\s:]/;

function isHighSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdbff;
}

function isLowSurrogate(codePoint: number): boolean {
  return codePoint >= 0xdc00 && codePoint <= 0xdfff;
}

function combineSurrogates(high: number, low: number): string {
  return String.fromCodePoint(
    ((high - 0xd800) << 10) + (low - 0xdc00) + 0x10000,
  );
}

export type CollectionType =
  | {
      type: 'object';
      keys: string[];
      values: JsonishValue[];
      completionState: CompletionState;
    }
  | { type: 'array'; values: JsonishValue[]; completionState: CompletionState }
  | {
      type: 'quotedString';
      contentBuffer: string[];
      completionState: CompletionState;
    }
  | {
      type: 'tripleQuotedString';
      contentBuffer: string[];
      completionState: CompletionState;
    }
  | {
      type: 'singleQuotedString';
      contentBuffer: string[];
      completionState: CompletionState;
    }
  | {
      type: 'backtickString';
      contentBuffer: string[];
      completionState: CompletionState;
    }
  | {
      type: 'tripleBacktickString';
      lang: string | null;
      contentBuffer: string[];
      completionState: CompletionState;
    }
  | {
      type: 'unquotedString';
      contentBuffer: string[];
      completionState: CompletionState;
    }
  | { type: 'trailingComment'; contentBuffer: string[] }
  | { type: 'blockComment'; contentBuffer: string[] };

export interface ParseState {
  collectionStack: Array<{ collection: CollectionType; fixes: JsonishFix[] }>;
  completedValues: Array<{
    name: string;
    value: JsonishValue;
    fixes: JsonishFix[];
  }>;
  trailingBackslashes: number;
  unescapedQuoteCount: number;
}

export function createParseState(): ParseState {
  return {
    collectionStack: [],
    completedValues: [],
    trailingBackslashes: 0,
    unescapedQuoteCount: 0,
  };
}

function resetQuoteTracking(state: ParseState): void {
  state.trailingBackslashes = 0;
  state.unescapedQuoteCount = 0;
}

function updateQuoteTracking(state: ParseState, char: string): void {
  if (char === '\\') {
    state.trailingBackslashes++;
  } else {
    if (char === '"' && state.trailingBackslashes % 2 === 0) {
      state.unescapedQuoteCount++;
    }
    state.trailingBackslashes = 0;
  }
}

function dedent(str: string): string {
  const lines = str.split('\n');
  if (lines.length === 0) return str;

  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = line.match(LEADING_WHITESPACE_REGEX);
    if (match) {
      minIndent = Math.min(minIndent, match[1].length);
    }
  }

  if (minIndent === Infinity || minIndent === 0) return str;

  return lines.map((line) => line.slice(minIndent)).join('\n');
}

function getContent(collection: CollectionType): string {
  if ('contentBuffer' in collection) {
    return collection.contentBuffer.join('');
  }
  return '';
}

function jsonishToString(value: JsonishValue): string {
  switch (value.type) {
    case 'string':
      return String(value.value ?? '');
    case 'number':
      return String(value.value);
    case 'boolean':
      return String(value.value);
    case 'null':
      return 'null';
    case 'object':
      return JSON.stringify(
        value.entries.reduce((acc, e) => ({ ...acc, [e.key]: e.value }), {}),
      );
    case 'array':
      return JSON.stringify(value.items);
    case 'anyOf':
      return value.originalString;
    case 'fixed':
      return jsonishToString(value.value);
    case 'markdown':
      return jsonishToString(value.value);
  }
}

function collectionToValue(collection: CollectionType): JsonishValue | null {
  switch (collection.type) {
    case 'trailingComment':
    case 'blockComment':
      return null;
    case 'object': {
      const entries: Array<{ key: string; value: JsonishValue }> = [];
      for (
        let i = 0;
        i < collection.keys.length && i < collection.values.length;
        i++
      ) {
        entries.push({ key: collection.keys[i], value: collection.values[i] });
      }
      return {
        type: 'object',
        entries,
        completionState: collection.completionState,
      };
    }
    case 'array':
      return {
        type: 'array',
        items: collection.values,
        completionState: collection.completionState,
      };
    case 'quotedString':
    case 'singleQuotedString':
    case 'backtickString':
      return {
        type: 'string',
        value: getContent(collection),
        completionState: collection.completionState,
      };
    case 'tripleQuotedString':
    case 'tripleBacktickString': {
      const content = getContent(collection);
      const firstNewline = content.indexOf('\n');
      if (firstNewline < 0) {
        return {
          type: 'string',
          value: content,
          completionState: collection.completionState,
        };
      }
      const firstLine = content.slice(0, firstNewline).trim();
      const hasLangTag =
        /^[a-zA-Z0-9_-]*$/.test(firstLine) && firstLine.length <= 20;
      if (hasLangTag) {
        const afterFirstLine = content.slice(firstNewline + 1);
        const dedented = dedent(afterFirstLine);
        return {
          type: 'string',
          value: dedented,
          completionState: collection.completionState,
        };
      }
      return {
        type: 'string',
        value: dedent(content),
        completionState: collection.completionState,
      };
    }
    case 'unquotedString': {
      const trimmed = getContent(collection).trim();
      if (trimmed === 'true')
        return { type: 'boolean', value: true, completionState: 'complete' };
      if (trimmed === 'false')
        return { type: 'boolean', value: false, completionState: 'complete' };
      if (trimmed === 'null')
        return { type: 'null', value: null, completionState: 'complete' };

      const intVal = parseInt(trimmed, 10);
      if (!Number.isNaN(intVal) && String(intVal) === trimmed) {
        return {
          type: 'number',
          value: intVal,
          completionState: collection.completionState,
        };
      }

      const floatVal = parseFloat(trimmed);
      if (!Number.isNaN(floatVal)) {
        return {
          type: 'number',
          value: floatVal,
          completionState: collection.completionState,
        };
      }

      return {
        type: 'string',
        value: trimmed,
        completionState: collection.completionState,
      };
    }
  }
}

function completeValueDeeply(value: JsonishValue): void {
  switch (value.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      (value as { completionState: CompletionState }).completionState =
        'complete';
      break;
    case 'object':
      value.completionState = 'complete';
      for (const entry of value.entries) {
        completeValueDeeply(entry.value);
      }
      break;
    case 'array':
      value.completionState = 'complete';
      for (const item of value.items) {
        completeValueDeeply(item);
      }
      break;
    case 'markdown':
      value.completionState = 'complete';
      completeValueDeeply(value.value);
      break;
    case 'fixed':
      completeValueDeeply(value.value);
      break;
    case 'anyOf':
      for (const c of value.candidates) {
        completeValueDeeply(c);
      }
      break;
  }
}

function completeCollection(
  state: ParseState,
  completionState: CompletionState,
): void {
  const popped = state.collectionStack.pop();
  if (!popped) return;

  const { collection, fixes } = popped;
  if ('completionState' in collection) {
    collection.completionState = completionState;
  }

  const value = collectionToValue(collection);
  if (!value) return;

  if (completionState === 'complete') {
    completeValueDeeply(value);
  }

  const last = state.collectionStack[state.collectionStack.length - 1];
  if (last) {
    const lastColl = last.collection;
    if (lastColl.type === 'object') {
      if (lastColl.keys.length === lastColl.values.length) {
        if (value.type === 'string' && typeof value.value === 'string') {
          lastColl.keys.push(value.value);
        } else if (value.type === 'anyOf') {
          lastColl.keys.push(
            (value as { originalString: string }).originalString,
          );
        } else {
          lastColl.keys.push(jsonishToString(value));
        }
      } else {
        lastColl.values.push(value);
      }
    } else if (lastColl.type === 'array') {
      lastColl.values.push(value);
    }
  } else {
    const name =
      collection.type === 'object'
        ? 'Object'
        : collection.type === 'array'
          ? 'Array'
          : 'string';
    state.completedValues.push({ name, value, fixes });
  }
}

function consumeChar(state: ParseState, char: string): void {
  const last = state.collectionStack[state.collectionStack.length - 1];
  if (!last) return;

  const coll = last.collection;
  if (coll.type === 'quotedString') {
    updateQuoteTracking(state, char);
  }

  if ('contentBuffer' in coll) {
    coll.contentBuffer.push(char);
  }
}

type Position =
  | 'inNothing'
  | 'unknown'
  | 'inObjectKey'
  | 'inObjectValue'
  | 'inArray';

function getCurrentPosition(state: ParseState): Position {
  if (state.collectionStack.length < 2) return 'inNothing';

  const parent =
    state.collectionStack[state.collectionStack.length - 2].collection;
  if (parent.type === 'object') {
    return parent.keys.length === parent.values.length
      ? 'inObjectKey'
      : 'inObjectValue';
  }
  if (parent.type === 'array') {
    return 'inArray';
  }
  return 'unknown';
}

function startsWithAt(str: string, index: number, prefix: string): boolean {
  if (index + prefix.length > str.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (str[index + i] !== prefix[i]) return false;
  }
  return true;
}

function charAtSafe(str: string, index: number): string | undefined {
  return index >= 0 && index < str.length ? str[index] : undefined;
}

function isHex4At(str: string, index: number): boolean {
  if (index + 4 > str.length) return false;
  for (let i = 0; i < 4; i++) {
    const c = str[index + i];
    const valid =
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'f') ||
      (c >= 'A' && c <= 'F');
    if (!valid) return false;
  }
  return true;
}

function getHex4At(str: string, index: number): string {
  return str[index] + str[index + 1] + str[index + 2] + str[index + 3];
}

function shouldCloseQuotedString(
  state: ParseState,
  str: string,
  afterQuoteIndex: number,
  closingChar: string,
): boolean {
  const pos = getCurrentPosition(state);
  const hasParent = state.collectionStack.length >= 2;
  const inObjectKey = pos === 'inObjectKey';
  const inObjectValue = pos === 'inObjectValue';
  const inArray = pos === 'inArray';

  const quoteCount = closingChar === '"' ? state.unescapedQuoteCount : 0;
  const remaining = str.length - afterQuoteIndex;

  if (remaining === 0) return true;

  const nextChar = str[afterQuoteIndex];

  if ((nextChar === ':' || nextChar === '}') && inObjectKey) return true;
  if (nextChar === ',' && (inObjectValue || inArray)) {
    return quoteCount % 2 === 0;
  }
  if (nextChar === '}' && inObjectValue) return true;
  if (nextChar === ']' && inArray) return true;

  if (WHITESPACE_REGEX.test(nextChar)) {
    let i = afterQuoteIndex;
    while (i < str.length && WHITESPACE_REGEX.test(str[i])) i++;
    if (i >= str.length) return true;

    const afterWhitespace = str[i];
    if (afterWhitespace === '}' && (inObjectKey || inObjectValue)) return true;
    if (afterWhitespace === ':' && inObjectKey) return true;
    if (afterWhitespace === ',' && inObjectValue) return true;
    if ((afterWhitespace === ',' || afterWhitespace === ']') && inArray)
      return true;
    if (afterWhitespace === '/' && charAtSafe(str, i + 1) === '/') return true;
    if (afterWhitespace === '/' && charAtSafe(str, i + 1) === '*') return true;
    return false;
  }

  if (nextChar === closingChar) return false;
  if (
    (nextChar === '{' ||
      nextChar === '"' ||
      nextChar === "'" ||
      nextChar === '[') &&
    !hasParent
  ) {
    return true;
  }

  return false;
}

function shouldCloseUnquotedString(
  state: ParseState,
  str: string,
  index: number,
): { close: boolean; skip: number; completionState: CompletionState } {
  const pos = getCurrentPosition(state);
  const current =
    state.collectionStack[state.collectionStack.length - 1]?.collection;

  if (current?.type !== 'unquotedString') {
    return { close: false, skip: 0, completionState: 'incomplete' };
  }

  if (index >= str.length) {
    return { close: true, skip: 0, completionState: 'incomplete' };
  }

  const nextChar = str[index];
  const content = getContent(current);
  const trimmedContent = content.trim();

  const isKnownValue =
    trimmedContent === 'true' ||
    trimmedContent === 'false' ||
    trimmedContent === 'null' ||
    !Number.isNaN(parseFloat(trimmedContent));

  if (isKnownValue && UNQUOTED_DELIMITER_REGEX.test(nextChar)) {
    return { close: true, skip: 0, completionState: 'complete' };
  }

  if (pos === 'inObjectKey') {
    if (nextChar === ':') {
      return { close: true, skip: 0, completionState: 'complete' };
    }
    if (WHITESPACE_REGEX.test(nextChar)) {
      let i = index;
      while (i < str.length && WHITESPACE_REGEX.test(str[i])) i++;
      if (i < str.length && str[i] === ':') {
        return { close: true, skip: i - index, completionState: 'complete' };
      }
    }
  }

  if (pos === 'inObjectValue') {
    if (nextChar === ',' || nextChar === '}' || nextChar === '\n') {
      return { close: true, skip: 0, completionState: 'complete' };
    }
    if (WHITESPACE_REGEX.test(nextChar)) {
      let i = index;
      while (i < str.length && WHITESPACE_REGEX.test(str[i])) i++;
      if (i < str.length) {
        const afterWs = str[i];
        if (afterWs === ',' || afterWs === '}') {
          return { close: true, skip: i - index, completionState: 'complete' };
        }
        if (afterWs === '/' && charAtSafe(str, i + 1) === '/') {
          return { close: true, skip: i - index, completionState: 'complete' };
        }
        if (afterWs === '/' && charAtSafe(str, i + 1) === '*') {
          return { close: true, skip: i - index, completionState: 'complete' };
        }
      }
    }
  }

  if (pos === 'inArray') {
    if (nextChar === ',' || nextChar === ']') {
      return { close: true, skip: 0, completionState: 'complete' };
    }
    if (WHITESPACE_REGEX.test(nextChar)) {
      let i = index;
      while (i < str.length && WHITESPACE_REGEX.test(str[i])) i++;
      if (i < str.length) {
        const afterWs = str[i];
        if (afterWs === ',' || afterWs === ']') {
          return { close: true, skip: i - index, completionState: 'complete' };
        }
        if (afterWs === '/' && charAtSafe(str, i + 1) === '/') {
          return { close: true, skip: i - index, completionState: 'complete' };
        }
        if (afterWs === '/' && charAtSafe(str, i + 1) === '*') {
          return { close: true, skip: i - index, completionState: 'complete' };
        }
      }
    }
  }

  if (pos === 'inNothing') {
    if (nextChar === '{' || nextChar === '[') {
      return { close: true, skip: 0, completionState: 'complete' };
    }
  }

  return { close: false, skip: 0, completionState: 'incomplete' };
}

function findStartingValue(
  state: ParseState,
  str: string,
  index: number,
): number {
  const char = str[index];
  const afterIndex = index + 1;

  switch (char) {
    case '{':
      state.collectionStack.push({
        collection: {
          type: 'object',
          keys: [],
          values: [],
          completionState: 'incomplete',
        },
        fixes: [],
      });
      return 0;

    case '[':
      state.collectionStack.push({
        collection: {
          type: 'array',
          values: [],
          completionState: 'incomplete',
        },
        fixes: [],
      });
      return 0;

    case '"':
      if (startsWithAt(str, afterIndex, '""')) {
        state.collectionStack.push({
          collection: {
            type: 'tripleQuotedString',
            contentBuffer: [],
            completionState: 'incomplete',
          },
          fixes: [],
        });
        return 2;
      }
      resetQuoteTracking(state);
      state.collectionStack.push({
        collection: {
          type: 'quotedString',
          contentBuffer: [],
          completionState: 'incomplete',
        },
        fixes: [],
      });
      return 0;

    case "'":
      state.collectionStack.push({
        collection: {
          type: 'singleQuotedString',
          contentBuffer: [],
          completionState: 'incomplete',
        },
        fixes: [],
      });
      return 0;

    case '`':
      if (startsWithAt(str, afterIndex, '``')) {
        state.collectionStack.push({
          collection: {
            type: 'tripleBacktickString',
            lang: null,
            contentBuffer: [],
            completionState: 'incomplete',
          },
          fixes: [],
        });
        return 2;
      }
      state.collectionStack.push({
        collection: {
          type: 'backtickString',
          contentBuffer: [],
          completionState: 'incomplete',
        },
        fixes: [],
      });
      return 0;

    case '/':
      if (charAtSafe(str, afterIndex) === '/') {
        state.collectionStack.push({
          collection: { type: 'trailingComment', contentBuffer: [] },
          fixes: [],
        });
        return 1;
      }
      if (charAtSafe(str, afterIndex) === '*') {
        state.collectionStack.push({
          collection: { type: 'blockComment', contentBuffer: [] },
          fixes: [],
        });
        return 1;
      }
      if (state.collectionStack.length > 0) {
        state.collectionStack.push({
          collection: {
            type: 'unquotedString',
            contentBuffer: [char],
            completionState: 'incomplete',
          },
          fixes: [],
        });
      }
      return 0;

    default:
      if (WHITESPACE_REGEX.test(char)) return 0;

      state.collectionStack.push({
        collection: {
          type: 'unquotedString',
          contentBuffer: [char],
          completionState: 'incomplete',
        },
        fixes: [],
      });
      return 0;
  }
}

type TokenHandler = (
  state: ParseState,
  str: string,
  index: number,
  char: string,
  afterIndex: number,
) => number;

const handleObject: TokenHandler = (state, str, index, char) => {
  if (char === '}') {
    completeCollection(state, 'complete');
    return 0;
  }
  if (char === ',' || char === ':') return 0;
  return findStartingValue(state, str, index);
};

const handleArray: TokenHandler = (state, str, index, char) => {
  if (char === ']') {
    completeCollection(state, 'complete');
    return 0;
  }
  if (char === ',') return 0;
  return findStartingValue(state, str, index);
};

const handleTripleQuotedString: TokenHandler = (
  state,
  str,
  _index,
  char,
  afterIndex,
) => {
  if (char === '"' && startsWithAt(str, afterIndex, '""')) {
    completeCollection(state, 'complete');
    return 2;
  }
  consumeChar(state, char);
  return 0;
};

const handleQuotedString: TokenHandler = (
  state,
  str,
  _index,
  char,
  afterIndex,
) => {
  if (char === '"') {
    if (shouldCloseQuotedString(state, str, afterIndex, '"')) {
      completeCollection(state, 'complete');
      return 0;
    }
    consumeChar(state, char);
    return 0;
  }
  if (char === '\\' && afterIndex < str.length) {
    const next = str[afterIndex];
    const escapeMap: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      b: '\b',
      f: '\f',
      '\\': '\\',
      '"': '"',
    };
    if (escapeMap[next]) {
      consumeChar(state, escapeMap[next]);
      return 1;
    }
    if (next === 'u' && isHex4At(str, afterIndex + 1)) {
      const hex = getHex4At(str, afterIndex + 1);
      const codePoint = parseInt(hex, 16);
      if (
        isHighSurrogate(codePoint) &&
        startsWithAt(str, afterIndex + 5, '\\u') &&
        isHex4At(str, afterIndex + 7)
      ) {
        const lowHex = getHex4At(str, afterIndex + 7);
        const lowCodePoint = parseInt(lowHex, 16);
        if (isLowSurrogate(lowCodePoint)) {
          consumeChar(state, combineSurrogates(codePoint, lowCodePoint));
          return 11;
        }
      }
      consumeChar(state, String.fromCharCode(codePoint));
      return 5;
    }
  }
  consumeChar(state, char);
  return 0;
};

const handleTripleBacktickString: TokenHandler = (
  state,
  str,
  _index,
  char,
  afterIndex,
) => {
  if (char === '`' && startsWithAt(str, afterIndex, '``')) {
    completeCollection(state, 'complete');
    return 2;
  }
  consumeChar(state, char);
  return 0;
};

const handleBacktickString: TokenHandler = (
  state,
  str,
  _index,
  char,
  afterIndex,
) => {
  if (char === '`') {
    if (shouldCloseQuotedString(state, str, afterIndex, '`')) {
      completeCollection(state, 'complete');
      return 0;
    }
  }
  consumeChar(state, char);
  return 0;
};

const handleSingleQuotedString: TokenHandler = (
  state,
  str,
  _index,
  char,
  afterIndex,
) => {
  if (char === "'") {
    if (shouldCloseQuotedString(state, str, afterIndex, "'")) {
      completeCollection(state, 'complete');
      return 0;
    }
  }
  consumeChar(state, char);
  return 0;
};

const handleUnquotedString: TokenHandler = (
  state,
  str,
  _index,
  char,
  afterIndex,
) => {
  consumeChar(state, char);
  const result = shouldCloseUnquotedString(state, str, afterIndex);
  if (result.close) {
    completeCollection(state, result.completionState);
    return result.skip;
  }
  return 0;
};

const handleTrailingComment: TokenHandler = (state, _str, _index, char) => {
  if (char === '\n') {
    completeCollection(state, 'complete');
    return 0;
  }
  consumeChar(state, char);
  return 0;
};

const handleBlockComment: TokenHandler = (
  state,
  str,
  _index,
  char,
  afterIndex,
) => {
  if (char === '*' && charAtSafe(str, afterIndex) === '/') {
    completeCollection(state, 'complete');
    return 1;
  }
  consumeChar(state, char);
  return 0;
};

const tokenHandlers: Record<CollectionType['type'], TokenHandler> = {
  object: handleObject,
  array: handleArray,
  tripleQuotedString: handleTripleQuotedString,
  quotedString: handleQuotedString,
  tripleBacktickString: handleTripleBacktickString,
  backtickString: handleBacktickString,
  singleQuotedString: handleSingleQuotedString,
  unquotedString: handleUnquotedString,
  trailingComment: handleTrailingComment,
  blockComment: handleBlockComment,
};

function processToken(state: ParseState, str: string, index: number): number {
  const char = str[index];
  const afterIndex = index + 1;
  const last = state.collectionStack[state.collectionStack.length - 1];

  if (!last) {
    return findStartingValue(state, str, index);
  }

  const handler = tokenHandlers[last.collection.type];
  return handler(state, str, index, char, afterIndex);
}

export interface ParseWithFixingResult {
  values: Array<{ name: string; value: JsonishValue; fixes: JsonishFix[] }>;
  error?: string;
}

export function parseWithFixingParser(str: string): ParseWithFixingResult {
  const state = createParseState();

  let i = 0;
  while (i < str.length) {
    const skip = processToken(state, str, i);
    i += 1 + skip;
  }

  while (state.collectionStack.length > 0) {
    completeCollection(state, 'incomplete');
  }

  if (state.completedValues.length === 0) {
    return { values: [], error: 'No JSON values found' };
  }

  return { values: state.completedValues };
}
