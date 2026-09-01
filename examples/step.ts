/**
 * Step Example
 *
 * The step primitive is the unified building block for executing code in workflows. Steps can:
 *
 * - Execute code and return void (simple side effects)
 * - Use signals: ctx.skip(), ctx.respond(text), ctx.fail(msg) (throw internally, no return needed)
 * - Return a runnable to delegate execution to (routing)
 *
 * This example demonstrates:
 *
 * - Data fetching before agent processing
 * - Validation gates with signals
 * - Dynamic routing to different agents
 * - State initialization and transformation
 *
 * Architecture: ┌───────────────────────────────────────────────────────────────────────┐ │ GATED
 * DATA PIPELINE │ │ │ │ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐ │ │ │
 * auth_gate │──►│ fetch │──►│ process │──►│ mode_router │ │ │ │ (step) │ │ (step) │ │ (step) │ │
 * (step) │ │ │ └────────────┘ └────────────┘ └────────────┘ └─────────────┘ │ │ │ │ │ │
 * fail/proceed ┌──────────┴────────┐ │ │ │ │ │ │ ┌─────▼─────┐ ┌────────▼┐│ │ │ analyzer │ │
 * summary ││ │ │ (agent) │ │ (agent) ││ │ └───────────┘ └─────────┘│
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Run: npx tsx examples/step.ts
 */

import { z } from 'zod'

import { adk, type StateSchema } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const processedProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  price: z.number(),
  stock: z.number(),
  inStock: z.boolean(),
  priceCategory: z.string(),
  totalValue: z.number(),
})

const summarySchema = z.object({
  totalProducts: z.number(),
  totalValue: z.number(),
  byCategory: z.object({
    budget: z.number(),
    midRange: z.number(),
    premium: z.number(),
  }),
})

const rawProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  price: z.number(),
  stock: z.number(),
})

const stateSchema = {
  session: {
    authenticated: z.boolean(),
    role: z.enum(['user', 'admin', 'guest']),
    mode: z.enum(['analyze', 'summarize']),
    rawProducts: z.array(rawProductSchema),
    fetchedAt: z.string(),
    products: z.array(processedProductSchema),
    summary: summarySchema,
  },
} satisfies StateSchema

const app = adk({ schema: stateSchema })

const mockDatabase = {
  products: [
    { id: 1, name: 'Laptop', price: 999, stock: 15 },
    { id: 2, name: 'Mouse', price: 29, stock: 150 },
    { id: 3, name: 'Keyboard', price: 79, stock: 80 },
    { id: 4, name: 'Monitor', price: 399, stock: 25 },
  ],
}

const authGate = app.step({
  name: 'auth_gate',
  description: 'Verifies user authentication before proceeding',
  execute: (ctx) => {
    if (!ctx.state.authenticated) {
      return ctx.fail('Authentication required. Please log in first.')
    }

    if (ctx.state.role !== 'user' && ctx.state.role !== 'admin') {
      return ctx.respond('Your account type does not have access to this feature.')
    }
  },
})

const fetchStep = app.step({
  name: 'fetch_data',
  description: 'Fetches product data from the database',
  execute: async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    ctx.state.update({
      rawProducts: mockDatabase.products,
      fetchedAt: new Date().toISOString(),
    })
  },
})

const processStep = app.step({
  name: 'process_data',
  description: 'Transforms and enriches the raw data',
  execute: (ctx) => {
    const products = ctx.state.rawProducts ?? []

    const processed = products.map((p) => ({
      ...p,
      inStock: p.stock > 0,
      priceCategory: p.price < 50 ? 'budget' : p.price < 200 ? 'mid-range' : 'premium',
      totalValue: p.price * p.stock,
    }))

    const summary = {
      totalProducts: products.length,
      totalValue: processed.reduce((sum, p) => sum + p.totalValue, 0),
      byCategory: {
        budget: processed.filter((p) => p.priceCategory === 'budget').length,
        midRange: processed.filter((p) => p.priceCategory === 'mid-range').length,
        premium: processed.filter((p) => p.priceCategory === 'premium').length,
      },
    }

    ctx.state.update({ products: processed, summary })
  },
})

const analyzerAgent = app.agent({
  name: 'analyzer',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
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
    ),
    app.context.history(),
  ],
})

const summaryAgent = app.agent({
  name: 'summary',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      (ctx) => `You are a concise summarizer.
    
Provide a brief, high-level summary of the inventory data.
Focus on key metrics and actionable insights.

## Summary
${JSON.stringify(ctx.state.summary, null, 2)}`,
    ),
    app.context.history(),
  ],
})

const modeRouter = app.step({
  name: 'mode_router',
  description: 'Routes to appropriate agent based on analysis mode',
  execute: (ctx) => {
    switch (ctx.state.mode) {
      case 'analyze':
        return analyzerAgent
      case 'summarize':
        return summaryAgent
      default:
        return analyzerAgent
    }
  },
})

const dataPipeline = app.sequence({
  name: 'data_pipeline',
  runnables: [authGate, fetchStep, processStep, modeRouter],
})

;(async () => {
  const session = await app.sessions.create()
  session.state.update({ authenticated: true, role: 'user', mode: 'analyze' })

  app.cli(dataPipeline, {
    session,
    input: 'Give me an overview of the inventory',
  })
})()
