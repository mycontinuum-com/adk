import { parseWithFixingParser } from './state-machine';

const FENCE_START_REGEX = /^[ \t]*```([a-zA-Z0-9 ]*)\n/m;
const SIMPLE_FENCE_REGEX = /```(?:json)?\s*([\s\S]*?)```/;
const FENCE_END_REGEX = /^[ \t]*```(?:\n|$)/gm;
const PRIMITIVE_REGEX =
  /(?:^|\s)(null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")(?:\s|$)/;

export function extractBalancedJsonObjects(str: string): string[] {
  const results: string[] = [];
  const stack: string[] = [];
  let jsonStart: number | null = null;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (
      char === '"' &&
      (stack.length === 0 || stack[stack.length - 1] !== "'")
    ) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      if (stack.length === 0) {
        jsonStart = i;
      }
      stack.push(char);
    } else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.length > 0 && stack[stack.length - 1] === expected) {
        stack.pop();
        if (stack.length === 0 && jsonStart !== null) {
          results.push(str.slice(jsonStart, i + 1));
          jsonStart = null;
        }
      }
    }
  }

  if (stack.length > 0 && jsonStart !== null) {
    results.push(str.slice(jsonStart));
  }

  return results;
}

function extractMarkdownContent(text: string): string | null {
  const startMatch = FENCE_START_REGEX.exec(text);
  if (!startMatch) {
    const simpleFence = text.match(SIMPLE_FENCE_REGEX);
    if (simpleFence) {
      return simpleFence[1].trim();
    }
    return null;
  }

  const afterStart = text.slice(startMatch.index + startMatch[0].length);
  FENCE_END_REGEX.lastIndex = 0;
  const ends: number[] = [];
  let endMatch;
  while ((endMatch = FENCE_END_REGEX.exec(afterStart)) !== null) {
    ends.push(endMatch.index);
  }

  if (ends.length === 0) {
    return afterStart.trim();
  }

  for (const endPos of ends) {
    const candidate = afterStart.slice(0, endPos).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      const result = parseWithFixingParser(candidate);
      if (result.values.length > 0 && result.values[0].name !== 'string') {
        return candidate;
      }
    }
  }

  return afterStart.slice(0, ends[0]).trim();
}

function findJsonStart(content: string): string {
  const objectStart = content.indexOf('{');
  const arrayStart = content.indexOf('[');

  let jsonStart = -1;
  if (objectStart !== -1 && arrayStart !== -1) {
    jsonStart = Math.min(objectStart, arrayStart);
  } else if (objectStart !== -1) {
    jsonStart = objectStart;
  } else if (arrayStart !== -1) {
    jsonStart = arrayStart;
  }

  if (jsonStart > 0) {
    return content.slice(jsonStart);
  }

  return content;
}

function trimTrailingNonJson(content: string): string {
  const lastBrace = content.lastIndexOf('}');
  const lastBracket = content.lastIndexOf(']');
  const lastJsonChar = Math.max(lastBrace, lastBracket);
  if (lastJsonChar !== -1 && lastJsonChar < content.length - 1) {
    return content.slice(0, lastJsonChar + 1);
  }
  return content;
}

export function extractJsonFromText(text: string): string {
  let content = text.trim();

  const jsonStart = content.indexOf('{');
  const arrayStart = content.indexOf('[');

  const startsWithJson = jsonStart === 0 || arrayStart === 0;
  if (!startsWithJson) {
    const markdownContent = extractMarkdownContent(content);
    if (markdownContent) {
      return markdownContent;
    }
  }

  if (jsonStart === -1 && arrayStart === -1) {
    const primitiveMatch = content.match(PRIMITIVE_REGEX);
    if (primitiveMatch) {
      return primitiveMatch[1];
    }
    return content;
  }

  content = findJsonStart(content);
  content = trimTrailingNonJson(content);

  return content;
}

export function getPositionFromOffset(
  content: string,
  offset: number,
): { line: number; column: number } {
  const lines = content.slice(0, offset).split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}
