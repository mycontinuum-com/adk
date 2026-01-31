/**
 * Multi-turn conversation debugging script
 *
 * Tests multi-turn conversation handling and context preservation.
 *
 * Usage:
 *   npx tsx scripts/debug-multi-turn.ts
 */

import { z } from 'zod';
import {
  agent,
  tool,
  BaseRunner,
  BaseSession,
  gemini,
  GeminiAdapter,
  injectSystemMessage,
  includeHistory,
} from '@anima/adk';

const calculate = tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  schema: z.object({
    expression: z.string().describe('The math expression to evaluate'),
  }),
  execute: (ctx) => {
    const result = Function(`"use strict"; return (${ctx.args.expression})`)();
    return { result };
  },
});

const assistant = agent({
  name: 'assistant',
  model: gemini('gemini-2.0-flash', {
    vertex: {
      project: 'anima-internal',
      location: 'europe-west1',
    },
  }),
  context: [
    injectSystemMessage(
      'You are a helpful assistant. Be concise. Use the calculator for math.',
    ),
    includeHistory(),
  ],
  tools: [calculate],
});

async function main() {
  const adapters = new Map([['gemini', new GeminiAdapter()]]);
  const runner = new BaseRunner({ adapters: adapters as any });

  // Start a session
  let session = new BaseSession('multi-turn-test');

  console.log('=== Multi-turn Conversation Test ===\n');

  // Turn 1
  console.log('User: What is 15 times 8?');
  session = session.addMessage('What is 15 times 8?');
  let result = await runner.run(assistant, session);
  session = result.session;
  let response = getLastAssistantMessage(session);
  console.log(`Assistant: ${response}\n`);

  // Turn 2 - follows up on previous context
  console.log('User: Now divide that by 3');
  session = session.addMessage('Now divide that by 3');
  result = await runner.run(assistant, session);
  session = result.session;
  response = getLastAssistantMessage(session);
  console.log(`Assistant: ${response}\n`);

  // Turn 3 - tests memory
  console.log('User: What were the two calculations we just did?');
  session = session.addMessage('What were the two calculations we just did?');
  result = await runner.run(assistant, session);
  session = result.session;
  response = getLastAssistantMessage(session);
  console.log(`Assistant: ${response}\n`);

  console.log('=== Test Complete ===');
}

function getLastAssistantMessage(session: BaseSession): string {
  const assistantEvents = session.events.filter((e) => e.type === 'assistant');
  const last = assistantEvents[assistantEvents.length - 1];
  return last && 'text' in last ? last.text : '(no response)';
}

main().catch(console.error);
