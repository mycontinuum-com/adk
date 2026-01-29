import type { Middleware } from './types';
import type { ToolCallEvent } from '../types';

export interface CliMiddlewareOptions {
  showThoughts?: boolean;
  showToolCalls?: boolean;
  dimThoughts?: boolean;
  dimToolOutput?: boolean;
  labelWidth?: number;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const COLORS = {
  gray: '\x1b[90m',
  white: '\x1b[37m',
  blueBright: '\x1b[94m',
  greenBright: '\x1b[92m',
  cyanBright: '\x1b[96m',
  yellowBright: '\x1b[93m',
} as const;

type ColorName = keyof typeof COLORS;

function findSafeRenderEnd(text: string): number {
  const incompletePattern = /\*\*[A-Z][^*]*$/;
  const match = text.match(incompletePattern);
  return match?.index ?? text.length;
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && Object.keys(value as object).length === 0)
    return '';
  return JSON.stringify(value);
}

function stripJsonNewlines(jsonStr: string): string {
  try {
    const parsed = JSON.parse(jsonStr);
    return JSON.stringify(parsed);
  } catch {
    return jsonStr.replace(/\s+/g, ' ').trim();
  }
}

function color(text: string, colorName: ColorName): string {
  return COLORS[colorName] + text + RESET;
}

function dim(text: string): string {
  return DIM + text + RESET;
}

function bold(text: string): string {
  return BOLD + text + RESET;
}

function renderJsonKeys(
  text: string,
  keyColor: ColorName,
  isDimmed: boolean,
): string {
  if (!text || !text.includes('":')) {
    return isDimmed ? dim(text) : text;
  }

  const keyRegex = /("[\w_-]+")(:\s*)/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = keyRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const prefix = text.slice(lastIndex, match.index);
      result += isDimmed ? dim(prefix) : prefix;
    }
    result += dim(color(match[1], keyColor));
    result += isDimmed ? dim(match[2]) : match[2];
    lastIndex = keyRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    const suffix = text.slice(lastIndex);
    result += isDimmed ? dim(suffix) : suffix;
  }

  return result || (isDimmed ? dim(text) : text);
}

function renderThoughtText(
  text: string,
  isDimmed: boolean = true,
  hasOutputBefore: boolean = false,
): string {
  if (!text || !text.includes('**')) {
    return isDimmed ? dim(text) : text;
  }

  const headingPattern = /\*\*([^*]+)\*\*/g;
  let result = '';
  let lastIndex = 0;
  let match;
  let afterHeading = false;

  while ((match = headingPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      let prefix = text.slice(lastIndex, match.index);
      if (afterHeading) prefix = prefix.replace(/^\n+/, '');
      if (prefix) result += isDimmed ? dim(prefix) : prefix;
    }
    if (result.length > 0 || hasOutputBefore) result += '\n\n';
    result += bold(match[1]) + '\n';
    lastIndex = match.index + match[0].length;
    afterHeading = true;
  }

  if (lastIndex < text.length) {
    let suffix = text.slice(lastIndex);
    if (afterHeading) suffix = suffix.replace(/^\n+/, '');
    if (suffix) result += isDimmed ? dim(suffix) : suffix;
  }

  return result || (isDimmed ? dim(text) : text);
}

function formatLabel(
  label: string,
  width: number,
  colorName: ColorName,
): string {
  const bracketed = `[${label}]`;
  const padding = ' '.repeat(Math.max(0, width - bracketed.length));
  return color(bracketed, colorName) + padding;
}

export function cliMiddleware(options: CliMiddlewareOptions = {}): Middleware {
  const {
    showThoughts = true,
    showToolCalls = true,
    dimThoughts = true,
    dimToolOutput = true,
    labelWidth = 8,
  } = options;

  let lastEventType: string | null = null;
  let thoughtBuffer = '';
  let lastRenderedPos = 0;
  let wasStreaming = false;

  const writeLabel = (label: string, colorName: ColorName): void => {
    process.stdout.write(formatLabel(label, labelWidth, colorName) + ' ');
  };

  const finalizeStreaming = (): boolean => {
    const hadStreaming = wasStreaming;
    const wasThought = lastEventType === 'thought_delta';

    if (wasThought) {
      if (thoughtBuffer.length > lastRenderedPos) {
        const remaining = thoughtBuffer.slice(lastRenderedPos);
        let rendered = renderThoughtText(
          remaining,
          dimThoughts,
          lastRenderedPos > 0,
        );
        rendered = rendered.replace(/\n+$/, '');
        process.stdout.write(rendered);
      }
      thoughtBuffer = '';
      lastRenderedPos = 0;
    }

    wasStreaming = false;
    if (hadStreaming) {
      process.stdout.write(wasThought ? '\n\n' : '\n');
      return true;
    }
    return false;
  };

  return {
    name: 'cli',

    onStream: (event) => {
      switch (event.type) {
        case 'thought_delta': {
          if (!showThoughts) {
            lastEventType = event.type;
            return;
          }
          if (lastEventType !== 'thought_delta') {
            if (!finalizeStreaming()) process.stdout.write('\n');
            writeLabel('think', 'white');
            thoughtBuffer = '';
            lastRenderedPos = 0;
          }
          thoughtBuffer = event.text;
          const safeEnd = findSafeRenderEnd(thoughtBuffer);
          if (safeEnd > lastRenderedPos) {
            const toRender = thoughtBuffer.slice(lastRenderedPos, safeEnd);
            const rendered = renderThoughtText(
              toRender,
              dimThoughts,
              lastRenderedPos > 0,
            );
            process.stdout.write(rendered);
            lastRenderedPos = safeEnd;
            wasStreaming = true;
          }
          break;
        }

        case 'thought': {
          finalizeStreaming();
          break;
        }

        case 'assistant_delta': {
          if (lastEventType !== 'assistant_delta') {
            if (!finalizeStreaming()) process.stdout.write('\n');
            writeLabel('output', 'greenBright');
          }
          const isJson =
            event.delta.trimStart().startsWith('{') ||
            event.delta.trimStart().startsWith('[');
          const content = isJson
            ? renderJsonKeys(event.delta, 'greenBright', false)
            : event.delta;
          process.stdout.write(content);
          wasStreaming = true;
          break;
        }

        case 'assistant': {
          finalizeStreaming();
          break;
        }

        case 'tool_call': {
          if (!showToolCalls) {
            lastEventType = event.type;
            return;
          }
          if (!finalizeStreaming()) process.stdout.write('\n');
          const e = event as ToolCallEvent;
          const labelColor: ColorName = e.yields
            ? 'yellowBright'
            : 'cyanBright';
          writeLabel('call', labelColor);
          const argsStr = formatJson(e.args);
          const compactArgs = argsStr ? stripJsonNewlines(argsStr) : '';
          const text = compactArgs
            ? dim(e.name + ' ') +
              renderJsonKeys(compactArgs, 'cyanBright', dimToolOutput)
            : dim(e.name);
          process.stdout.write(text + '\n');
          break;
        }

        case 'user': {
          if (!finalizeStreaming()) process.stdout.write('\n');
          writeLabel('user', 'blueBright');
          process.stdout.write(event.text + '\n');
          break;
        }
      }

      lastEventType = event.type;
    },
  };
}
