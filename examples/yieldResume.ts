/**
 * Yield/Resume Flow Example
 *
 * Demonstrates human-in-the-loop approval with the structured input form: 1. Agent yields when
 * calling a yielding tool 2. CLI shows JSON-style form to fill in 3. Use arrow keys to navigate,
 * Enter to submit
 *
 * Run: npx tsx examples/yieldResume.ts
 */

import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk()

const approvalTool = app.tool({
  name: 'request_approval',
  description: 'Request approval before proceeding with a purchase',
  schema: z.object({
    item: z.string().describe('The item to purchase'),
    amount: z.number().describe('The purchase amount in dollars'),
  }),
  yieldSchema: z.object({
    approvals: z.array(
      z.object({
        approved: z.boolean().describe('Whether to approve this purchase'),
      }),
    ),
  }),
  finalize: (ctx) => ({
    item: ctx.args.item,
    amount: ctx.args.amount,
    approvals: ctx.input?.approvals,
  }),
})

const purchaseTool = app.tool({
  name: 'make_purchase',
  description: 'Execute a purchase after approval has been granted',
  schema: z.object({
    item: z.string(),
    amount: z.number(),
  }),
  execute: (ctx) => ({
    orderId: `ORD-${Date.now()}`,
    item: ctx.args.item,
    amount: ctx.args.amount,
    status: 'completed',
  }),
})

const purchaseAgent = app.agent({
  name: 'purchase_agent',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(`You help users make purchases. Follow these rules:
1. Always use request_approval before making any purchase
2. Wait for approval before proceeding
3. If denied, suggest a cheaper alternative and request approval again
4. Only use make_purchase after receiving approved: true`),
    app.context.history(),
  ],
  tools: [approvalTool, purchaseTool],
})

app.cli(purchaseAgent, 'Buy a laptop for $1500')
