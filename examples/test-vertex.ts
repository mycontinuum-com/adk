/**
 * Quick test using Vertex AI (Gemini)
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
  model: gemini('gemini-2.0-flash', {
    vertex: {
      project: 'anima-internal',
      location: 'europe-west1',
      // Uses GOOGLE_APPLICATION_CREDENTIALS env var automatically
    },
  }),
  context: [
    injectSystemMessage(
      'You are a helpful math assistant. Use the calculator tool for arithmetic. Be concise.',
    ),
    includeHistory(),
  ],
  tools: [calculator],
});

async function main() {
  console.log('Running with Vertex AI (Gemini)...\n');
  
  // Create runner with only Gemini adapter (no OpenAI)
  const adapters = new Map<'gemini', typeof GeminiAdapter.prototype>();
  adapters.set('gemini', new GeminiAdapter());
  
  const runner = new BaseRunner({
    adapters: adapters as any,
  });
  
  const session = new BaseSession('test').addMessage('What is 134 divided by 4?');
  const result = await runner.run(assistant, session);
  
  console.log('\n--- Result ---');
  console.log('Status:', result.status);
  
  // Find the assistant's response
  const assistantEvents = result.session.events.filter(e => e.type === 'assistant');
  const lastResponse = assistantEvents[assistantEvents.length - 1];
  if (lastResponse && 'text' in lastResponse) {
    console.log('Response:', lastResponse.text);
  }
  
  // Show tool calls
  const toolCalls = result.session.events.filter(e => e.type === 'tool_call');
  if (toolCalls.length > 0) {
    console.log('Tool calls:', toolCalls.map(t => ('name' in t ? t.name : 'unknown')));
  }
}

main().catch(console.error);
