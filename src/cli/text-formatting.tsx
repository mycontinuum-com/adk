import React from 'react';
// @ts-ignore
import { Text } from 'ink';
import { MIN_CONTINUATION_WIDTH } from './constants';

export interface FormattingOptions {
  maxWidth: number;
  singleLine?: boolean;
  keyColor?: string;
  dimmed?: boolean;
}

export function renderJsonLine(text: string, keyColor: string, dimmed: boolean, skipHighlighting: boolean = false): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>;
  }
  
  if (skipHighlighting || !text.includes('":')) {
    return <Text dimColor={dimmed}>{text}</Text>;
  }
  
  const parts: React.ReactNode[] = [];
  const keyRegex = /("[\w_-]+")(:\s*)/g;
  let lastIndex = 0;
  let match;
  let keyIndex = 0;

  while ((match = keyRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`t${keyIndex}`} dimColor={dimmed}>{text.slice(lastIndex, match.index)}</Text>);
    }
    parts.push(<Text key={`k${keyIndex}`} color={keyColor} dimColor>{match[1]}</Text>);
    parts.push(<Text key={`c${keyIndex}`} dimColor={dimmed}>{match[2]}</Text>);
    lastIndex = keyRegex.lastIndex;
    keyIndex++;
  }

  if (lastIndex < text.length) {
    parts.push(<Text key={`t${keyIndex}`} dimColor={dimmed}>{text.slice(lastIndex)}</Text>);
  }

  if (parts.length === 0) {
    return <Text dimColor={dimmed}>{text}</Text>;
  }

  return <>{parts}</>;
}

export function renderThoughtText(text: string, dimmed: boolean = true, skipHighlighting: boolean = false): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>;
  }
  
  if (skipHighlighting || !text.includes('**')) {
    return <Text dimColor={dimmed}>{text}</Text>;
  }
  
  const parts: React.ReactNode[] = [];
  const headingPattern = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match;
  let keyIdx = 0;

  while ((match = headingPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`t${keyIdx++}`} dimColor={dimmed}>{text.slice(lastIndex, match.index)}</Text>);
    }
    parts.push(<Text key={`h${keyIdx++}`}>{match[1]}</Text>);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<Text key={`t${keyIdx++}`} dimColor={dimmed}>{text.slice(lastIndex)}</Text>);
  }

  if (parts.length === 0) {
    return <Text dimColor={dimmed}>{text}</Text>;
  }

  return <>{parts}</>;
}

export function renderToolCallLine(text: string, keyColor: string, dimmed: boolean = true, skipHighlighting: boolean = false): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>;
  }
  
  if (skipHighlighting) {
    return <Text dimColor={dimmed}>{text}</Text>;
  }
  
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx === -1) {
    return <Text dimColor={dimmed}>{text}</Text>;
  }
  const toolName = text.slice(0, spaceIdx);
  const argsText = text.slice(spaceIdx + 1);
  return (
    <>
      <Text dimColor={dimmed}>{toolName} </Text>
      {renderJsonLine(argsText, keyColor, dimmed, skipHighlighting)}
    </>
  );
}

export function renderToolResultLine(text: string, keyColor: string, dimmed: boolean = true, skipHighlighting: boolean = false): React.ReactNode {
  if (!text) {
    return <Text dimColor={dimmed}> </Text>;
  }
  
  if (skipHighlighting) {
    return <Text dimColor={dimmed}>{text}</Text>;
  }
  
  const arrowIdx = text.indexOf(' → ');
  if (arrowIdx === -1) {
    const isJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
    if (isJson) {
      return renderJsonLine(text, keyColor, dimmed, skipHighlighting);
    }
    return <Text dimColor={dimmed}>{text}</Text>;
  }
  const toolName = text.slice(0, arrowIdx);
  const resultText = text.slice(arrowIdx + 3);
  const isJson = resultText.trimStart().startsWith('{') || resultText.trimStart().startsWith('[');
  return (
    <>
      <Text dimColor={dimmed}>{toolName} → </Text>
      {isJson ? renderJsonLine(resultText, keyColor, dimmed, skipHighlighting) : <Text dimColor={dimmed}>{resultText}</Text>}
    </>
  );
}

const stripJsonCache = new Map<string, string>();
const MAX_STRIP_CACHE_SIZE = 1000;
const MAX_CACHEABLE_LENGTH = 10000;

export function stripJsonNewlines(jsonStr: string): string {
  if (jsonStr.length > MAX_CACHEABLE_LENGTH) {
    return jsonStr.replace(/\s+/g, ' ').trim();
  }
  
  const cached = stripJsonCache.get(jsonStr);
  if (cached !== undefined) return cached;
  
  let result: string;
  try {
    const parsed = JSON.parse(jsonStr);
    result = JSON.stringify(parsed);
  } catch {
    result = jsonStr.replace(/\s+/g, ' ').trim();
  }
  
  if (stripJsonCache.size >= MAX_STRIP_CACHE_SIZE) {
    const firstKey = stripJsonCache.keys().next().value;
    if (firstKey) stripJsonCache.delete(firstKey);
  }
  stripJsonCache.set(jsonStr, result);
  
  return result;
}

export function formatJsonForWidth(jsonStr: string, maxWidth: number): { text: string; isMultiLine: boolean } {
  const compact = stripJsonNewlines(jsonStr);
  if (compact.length <= maxWidth) {
    return { text: compact, isMultiLine: false };
  }
  
  try {
    const parsed = JSON.parse(jsonStr);
    return { text: JSON.stringify(parsed, null, 2), isMultiLine: true };
  } catch {
    return { text: jsonStr, isMultiLine: jsonStr.includes('\n') };
  }
}

export function formatThoughtTextSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function formatThoughtTextMultiLine(text: string): string {
  return text
    .replace(/\n\n+/g, '\n')
    .replace(/([^\n])\*\*([A-Z])/g, '$1\n**$2');
}

export function formatTextForWidth(
  text: string,
  maxWidth: number,
  isJson: boolean,
  isThought: boolean,
): { text: string; isMultiLine: boolean } {
  if (isJson) {
    return formatJsonForWidth(text, maxWidth);
  }

  if (isThought) {
    const singleLine = formatThoughtTextSingleLine(text);
    if (singleLine.length <= maxWidth) {
      return { text: singleLine, isMultiLine: false };
    }
    return { text: formatThoughtTextMultiLine(text), isMultiLine: true };
  }

  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxWidth) {
    return { text: singleLine, isMultiLine: false };
  }
  return { text, isMultiLine: text.includes('\n') };
}

export interface RenderFormattedTextOptions {
  text: string;
  eventType: 'assistant' | 'thought' | 'tool_call' | 'user' | 'delta_batch';
  deltaType?: 'assistant_delta' | 'thought_delta';
  keyColor?: string;
  dimmed?: boolean;
}

export function renderFormattedText(options: RenderFormattedTextOptions): React.ReactNode {
  const { text, eventType, deltaType, keyColor = 'greenBright', dimmed = false } = options;

  if (!text) {
    return <Text dimColor={dimmed}> </Text>;
  }

  const isThought = eventType === 'thought' || deltaType === 'thought_delta';
  const isAssistant = eventType === 'assistant' || deltaType === 'assistant_delta';
  const isToolCall = eventType === 'tool_call';

  if (isThought) {
    return renderThoughtText(text, dimmed);
  }

  if (isToolCall) {
    return renderToolCallLine(text, keyColor, dimmed);
  }

  if (isAssistant) {
    const isJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
    if (isJson) {
      return renderJsonLine(text, keyColor, dimmed);
    }
  }

  return <Text dimColor={dimmed}>{text || ' '}</Text>;
}

export function wrapTextToLines(text: string, maxWidth: number): string[] {
  const wrapLine = (sourceLine: string): string[] => {
    if (sourceLine.length <= maxWidth) return [sourceLine];

    const leadingMatch = sourceLine.match(/^(\s*)/);
    const leadingSpaces = leadingMatch ? leadingMatch[1] : '';
    const leadingLen = leadingSpaces.length;

    const findWrapPoint = (textToWrap: string, width: number): number => {
      if (textToWrap.length <= width) return textToWrap.length;
      const lastSpace = textToWrap.lastIndexOf(' ', width);
      if (lastSpace > width * 0.4) return lastSpace;
      return width;
    };

    const wrapped: string[] = [];
    let remaining = sourceLine;

    const firstWrap = findWrapPoint(remaining, maxWidth);
    wrapped.push(remaining.slice(0, firstWrap));
    remaining = remaining.slice(firstWrap).trimStart();

    const continuationWidth = Math.max(MIN_CONTINUATION_WIDTH, maxWidth - leadingLen);
    while (remaining.length > 0) {
      const wrapAt = findWrapPoint(remaining, continuationWidth);
      wrapped.push(leadingSpaces + remaining.slice(0, wrapAt));
      remaining = remaining.slice(wrapAt).trimStart();
    }

    return wrapped;
  };

  const sourceLines = text.split('\n');
  const allWrapped: string[] = [];
  for (const sourceLine of sourceLines) {
    allWrapped.push(...wrapLine(sourceLine));
  }
  return allWrapped;
}
