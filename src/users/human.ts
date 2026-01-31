import * as readline from 'readline';
import type {
  User,
  YieldContext,
  YieldResponse,
  HumanUserOptions,
} from '../types';

function defaultFormatPrompt(ctx: YieldContext): string {
  if (ctx.yieldType === 'loop') {
    return ctx.lastAssistantText
      ? `\n[Assistant]: ${ctx.lastAssistantText}\n\nYou: `
      : '\nYou: ';
  }

  const toolName = ctx.toolName ?? 'unknown';
  const args = ctx.args ? JSON.stringify(ctx.args, null, 2) : '{}';
  return `\n[Tool: ${toolName}]\nArgs: ${args}\n\nProvide input: `;
}

function defaultParseInput(input: string, ctx: YieldContext): unknown {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    if (ctx.yieldType === 'loop') {
      return trimmed;
    }
    return { answer: trimmed };
  }
}

export function humanUser(options?: HumanUserOptions): User {
  const formatPrompt = options?.formatPrompt ?? defaultFormatPrompt;
  const parseInput = options?.parseInput ?? defaultParseInput;

  let rl: readline.Interface | null = null;

  const getReadline = (): readline.Interface => {
    if (!rl) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return rl;
  };

  const prompt = (question: string): Promise<string> => {
    return new Promise((resolve) => {
      getReadline().question(question, (answer) => {
        resolve(answer);
      });
    });
  };

  return {
    name: 'HumanUser',

    async onYield(ctx: YieldContext): Promise<YieldResponse> {
      const promptText = formatPrompt(ctx);

      while (true) {
        const rawInput = await prompt(promptText);

        try {
          const parsed = parseInput(rawInput, ctx);

          if (ctx.yieldType === 'loop') {
            return {
              type: 'message',
              text: typeof parsed === 'string' ? parsed : rawInput,
            };
          }

          return { type: 'tool_input', input: parsed };
        } catch (error) {
          console.error(
            `Error parsing input: ${error instanceof Error ? error.message : String(error)}`,
          );
          console.log('Please try again.');
        }
      }
    },
  };
}

export function closeHumanUserReadline(): void {
  // Note: This is a placeholder for cleanup. In a real implementation,
  // you'd need to track the readline instance or use a different approach.
}
