/**
 * Reasoning Models Example
 *
 * Demonstrates using reasoning/thinking models from different providers:
 * - OpenAI: gpt-5-mini with reasoning effort
 * - Gemini: gemini-3-flash-preview with thinking config
 * - Claude: claude-sonnet-4-5 via Vertex AI
 *
 * Run: npx tsx examples/reasoning.ts
 */

import { z } from 'zod';
import {
  agent,
  tool,
  openai,
  gemini,
  claude,
  injectSystemMessage,
  includeHistory,
} from '../src';
import { cli } from '../src/cli';

type Provider = 'openai' | 'gemini' | 'gemini-vertex' | 'claude-vertex';

// Change this to test different providers
const PROVIDER: Provider = 'openai';

// For Vertex AI providers (gemini-vertex, claude-vertex)
const VERTEX_PROJECT = 'your-gcp-project';
const VERTEX_LOCATION = 'europe-west1';

function getModel(provider: Provider) {
  switch (provider) {
    case 'openai':
      return openai('gpt-5-mini', {
        reasoning: { effort: 'high', summary: 'detailed' },
      });

    case 'gemini':
      return gemini('gemini-2.0-flash', {
        thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
      });

    case 'gemini-vertex':
      return gemini('gemini-2.5-flash', {
        thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
        vertex: {
          project: VERTEX_PROJECT,
          location: VERTEX_LOCATION,
        },
      });

    case 'claude-vertex':
      return claude('claude-sonnet-4-5', {
        vertex: {
          project: VERTEX_PROJECT,
          location: VERTEX_LOCATION,
        },
      });
  }
}

const myAgent = agent({
  name: 'math_assistant',
  model: getModel(PROVIDER),
  context: [
    injectSystemMessage('Use tools for arithmetic step by step.'),
    includeHistory(),
  ],
  tools: [
    tool({
      name: 'divide',
      description: 'Divide a by b',
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: (ctx) => ({ result: ctx.args.a / ctx.args.b }),
    }),
    tool({
      name: 'hours_to_minutes',
      description: 'Convert hours to minutes',
      schema: z.object({
        hours: z.number().describe('The number of hours'),
      }),
      execute: (ctx) => ({ minutes: ctx.args.hours * 60 }),
    }),
  ],
});

cli(myAgent, 'I drove 134 miles at 40 mph, how many minutes did it take?');
