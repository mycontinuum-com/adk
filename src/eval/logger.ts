import type { Middleware } from '../middleware/types';

export type LogLevel = 'messages' | 'conversation' | 'all';

export interface EvalLoggerOptions {
  level?: LogLevel;
  prefix?: string;
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';

export function evalConversationLogger(
  options: EvalLoggerOptions = {},
): Middleware {
  const { level = 'conversation', prefix = '' } = options;
  const tag = prefix ? `${DIM}[${prefix}]${RESET} ` : '';

  return {
    name: 'eval-conversation-logger',

    onStream: (event) => {
      switch (event.type) {
        case 'user':
          console.log(`\n${tag}${BLUE}Patient:${RESET} ${event.text}`);
          break;

        case 'assistant':
          console.log(`\n${tag}${GREEN}System:${RESET} ${event.text}`);
          break;

        case 'tool_call':
          if (level === 'messages') break;
          console.log(
            `${tag}${DIM}${CYAN}[${event.name}]${RESET}${DIM} ${formatArgs(event.args)}${RESET}`,
          );
          break;

        case 'tool_result':
          if (level === 'messages') break;
          if (event.error) {
            console.log(
              `${tag}${DIM}${YELLOW}[error]${RESET}${DIM} ${event.error}${RESET}`,
            );
          } else {
            console.log(
              `${tag}${DIM}${GREEN}[result]${RESET}${DIM} ${formatResult(event.result)}${RESET}`,
            );
          }
          break;

        case 'state_change':
          if (level !== 'all') break;
          const changes = event.changes
            .map((c) => `${c.key}: ${JSON.stringify(c.newValue)}`)
            .join(', ');
          console.log(
            `${tag}${DIM}${MAGENTA}[state]${RESET}${DIM} ${changes}${RESET}`,
          );
          break;

        case 'thought':
          if (level !== 'all') break;
          console.log(`${tag}${DIM}[thought] ${event.text}${RESET}`);
          break;
      }
    },
  };
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'object' && Object.keys(args).length === 0) return '';
  const str = JSON.stringify(args);
  return str.length > 100 ? str.slice(0, 100) + '...' : str;
}

function formatResult(result: unknown): string {
  if (result === undefined || result === null) return 'void';
  if (typeof result === 'string') {
    return result.length > 100 ? result.slice(0, 100) + '...' : result;
  }
  const str = JSON.stringify(result);
  return str.length > 100 ? str.slice(0, 100) + '...' : str;
}
