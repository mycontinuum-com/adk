/**
 * Step Example
 *
 * The step primitive is the unified building block for executing code in workflows.
 * Steps can:
 * - Execute code and return void (simple side effects)
 * - Return signals: ctx.skip(), ctx.respond(text), ctx.fail(msg), ctx.complete(value)
 * - Return a runnable to delegate execution to (routing)
 *
 * This example demonstrates:
 * - Data fetching before agent processing
 * - Validation gates with signals
 * - Dynamic routing to different agents
 * - State initialization and transformation
 *
 * Architecture:
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │                        GATED DATA PIPELINE                            │
 * │                                                                       │
 * │  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌─────────────┐  │
 * │  │  auth_gate │──►│  fetch     │──►│  process   │──►│ mode_router │  │
 * │  │  (step)    │   │  (step)    │   │  (step)    │   │   (step)    │  │
 * │  └────────────┘   └────────────┘   └────────────┘   └─────────────┘  │
 * │       │                                                   │          │
 * │   fail/proceed                                 ┌──────────┴────────┐ │
 * │                                                │                   │ │
 * │                                          ┌─────▼─────┐   ┌────────▼┐│
 * │                                          │  analyzer │   │ summary ││
 * │                                          │  (agent)  │   │ (agent) ││
 * │                                          └───────────┘   └─────────┘│
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Run: npx tsx examples/step.ts
 */

import { z } from 'zod';
import {
  agent,
  step,
  sequence,
  openai,
  message,
  injectSystemMessage,
  includeHistory,
  InMemorySessionService,
  cli,
  type StateSchema,
} from '../src';

const processedProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  price: z.number(),
  stock: z.number(),
  inStock: z.boolean(),
  priceCategory: z.string(),
  totalValue: z.number(),
});

const summarySchema = z.object({
  totalProducts: z.number(),
  totalValue: z.number(),
  byCategory: z.object({
    budget: z.number(),
    midRange: z.number(),
    premium: z.number(),
  }),
});

const stateSchema = {
  session: {
    products: z.array(processedProductSchema),
    summary: summarySchema,
  },
} satisfies StateSchema;

const mockDatabase = {
  products: [
    { id: 1, name: 'Laptop', price: 999, stock: 15 },
    { id: 2, name: 'Mouse', price: 29, stock: 150 },
    { id: 3, name: 'Keyboard', price: 79, stock: 80 },
    { id: 4, name: 'Monitor', price: 399, stock: 25 },
  ],
};

const authGate = step({
  name: 'auth_gate',
  description: 'Verifies user authentication before proceeding',
  execute: (ctx) => {
    const authenticated = ctx.state.authenticated as boolean | undefined;
    const role = ctx.state.role as string | undefined;

    if (!authenticated) {
      return ctx.fail('Authentication required. Please log in first.');
    }

    if (role !== 'user' && role !== 'admin') {
      return ctx.respond(
        'Your account type does not have access to this feature.',
      );
    }
  },
});

const fetchStep = step({
  name: 'fetch_data',
  description: 'Fetches product data from the database',
  execute: async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctx.state.rawProducts = mockDatabase.products;
    ctx.state.fetchedAt = new Date().toISOString();
  },
});

const processStep = step({
  name: 'process_data',
  description: 'Transforms and enriches the raw data',
  execute: (ctx) => {
    const products =
      (ctx.state.rawProducts as typeof mockDatabase.products) || [];

    const processed = products.map((p) => ({
      ...p,
      inStock: p.stock > 0,
      priceCategory:
        p.price < 50 ? 'budget' : p.price < 200 ? 'mid-range' : 'premium',
      totalValue: p.price * p.stock,
    }));

    const summary = {
      totalProducts: products.length,
      totalValue: processed.reduce((sum, p) => sum + p.totalValue, 0),
      byCategory: {
        budget: processed.filter((p) => p.priceCategory === 'budget').length,
        midRange: processed.filter((p) => p.priceCategory === 'mid-range')
          .length,
        premium: processed.filter((p) => p.priceCategory === 'premium').length,
      },
    };

    ctx.state.products = processed;
    ctx.state.summary = summary;
  },
});

const analyzerPrompt = message(
  stateSchema,
  (ctx) => `You are a product inventory analyst.
    
Analyze the product data and summary provided. Answer questions about:
- Inventory levels and stock status
- Price distribution and categories
- Total value and recommendations

Be concise and data-driven in your responses.

## Product Data
${JSON.stringify(ctx.state.products, null, 2)}

## Summary
${JSON.stringify(ctx.state.summary, null, 2)}`,
);

const analyzerAgent = agent({
  name: 'analyzer',
  model: openai('gpt-4o-mini'),
  context: [injectSystemMessage(analyzerPrompt), includeHistory()],
});

const summaryPrompt = message(
  stateSchema,
  (ctx) => `You are a concise summarizer.
    
Provide a brief, high-level summary of the inventory data.
Focus on key metrics and actionable insights.

## Summary
${JSON.stringify(ctx.state.summary, null, 2)}`,
);

const summaryAgent = agent({
  name: 'summary',
  model: openai('gpt-4o-mini'),
  context: [injectSystemMessage(summaryPrompt), includeHistory()],
});

const modeRouter = step({
  name: 'mode_router',
  description: 'Routes to appropriate agent based on analysis mode',
  execute: (ctx) => {
    const mode = ctx.state.mode as string | undefined;

    switch (mode) {
      case 'analyze':
        return analyzerAgent;
      case 'summarize':
        return summaryAgent;
      default:
        return analyzerAgent;
    }
  },
});

const dataPipeline = sequence({
  name: 'data_pipeline',
  runnables: [authGate, fetchStep, processStep, modeRouter],
});

(async () => {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession(dataPipeline.name);
  session.state.update({
    session: { authenticated: true, role: 'user', mode: 'analyze' },
  });

  cli(dataPipeline, {
    sessionService,
    session,
    input: 'Give me an overview of the inventory',
  });
})();
