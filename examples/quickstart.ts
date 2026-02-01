import { z } from 'zod';
import {
  agent,
  tool,
  run,
  openai,
  injectSystemMessage,
  includeHistory,
} from '../src';

const calculator = tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  schema: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: (ctx) => {
    const sanitized = ctx.args.expression.replace(/[^\d\s+\-*/().eE%]/g, '');
    const result = Function(`"use strict"; return (${sanitized})`)();
    return { result };
  },
});

const assistant = agent({
  name: 'math_assistant',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(
      'You are a helpful math assistant. Use the calculator tool for arithmetic.',
    ),
    includeHistory(),
  ],
  tools: [calculator],
});

async function main() {
  const result = await run(assistant, 'What is 134 divided by 4?');
  console.log(result.session.events);
}

main().catch(console.error);
