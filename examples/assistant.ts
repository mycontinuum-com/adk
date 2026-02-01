/**
 * Interactive Chat Assistant
 *
 * A conversational assistant with a calculator tool, demonstrating
 * the loop primitive for multi-turn conversations.
 *
 * Run: npx tsx examples/assistant.ts
 */

import { z } from 'zod';
import {
  agent,
  tool,
  loop,
  openai,
  injectSystemMessage,
  includeHistory,
  cli,
  type LoopContext,
} from '../src';

const calculate = tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  schema: z.object({
    expression: z.string().describe('The math expression to evaluate'),
  }),
  execute: (ctx) => {
    try {
      const result = Function(
        `"use strict"; return (${ctx.args.expression})`,
      )();
      return { result };
    } catch {
      return { error: 'Invalid expression' };
    }
  },
});

const assistant = agent({
  name: 'assistant',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(`You are a friendly and helpful AI assistant.

Your capabilities:
- Answer questions on any topic
- Help with calculations using the calculate tool
- Remember context from earlier in the conversation

Be concise but thorough. Use tools when they would help answer the question.`),
    includeHistory(),
  ],
  tools: [calculate],
});

const EXIT_PHRASES = ['goodbye', 'exit', 'quit', 'bye'];

const chat = loop({
  name: 'chat',
  runnable: assistant,
  maxIterations: 100,
  yields: true,
  while: (ctx: LoopContext) => {
    const lastUser = [...ctx.session.events]
      .reverse()
      .find((e) => e.type === 'user');

    if (lastUser?.type === 'user') {
      const text = lastUser.text.toLowerCase();
      if (EXIT_PHRASES.some((phrase) => text.includes(phrase))) {
        return false;
      }
    }

    return true;
  },
});

cli(chat);
