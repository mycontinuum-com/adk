/**
 * Yield/Resume Flow Example
 *
 * Demonstrates human-in-the-loop approval with the structured input form:
 * 1. Agent yields when calling a yielding tool
 * 2. CLI shows JSON-style form to fill in
 * 3. Use arrow keys to navigate, Enter to submit
 *
 * Run: npx tsx examples/yieldResume.ts
 */

import { z } from 'zod';
import {
  agent,
  tool,
  openai,
  injectSystemMessage,
  includeHistory,
  cli,
} from '../src';


const approvalTool = tool({
  name: 'request_approval',
  description: 'Request approval before proceeding with a purchase',
  schema: z.object({
    item: z.string().describe('The item to purchase'),
    amount: z.number().describe('The purchase amount in dollars'),
  }),
  yieldSchema: z.object({
    approved: z.boolean().describe('Whether to approve this purchase'),
    reason: z.string().optional().describe('Reason for decision'),
  }),
  finalize: (ctx) => ({
    item: ctx.args.item,
    amount: ctx.args.amount,
    approved: ctx.input?.approved,
    reason: ctx.input?.reason,
  }),
});

const purchaseTool = tool({
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
});

const purchaseAgent = agent({
  name: 'purchase_agent',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(`You help users make purchases. Follow these rules:
1. Always use request_approval before making any purchase
2. Wait for approval before proceeding
3. If denied, suggest a cheaper alternative and request approval again
4. Only use make_purchase after receiving approved: true`),
    includeHistory(),
  ],
  tools: [approvalTool, purchaseTool],
});

cli(purchaseAgent, 'Buy a laptop for $1500');
