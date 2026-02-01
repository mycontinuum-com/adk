/**
 * Dynamic Orchestration Example
 *
 * Demonstrates the four dynamic orchestration patterns:
 * - call: Synchronous call to another agent (waits for result)
 * - spawn: Asynchronous spawn (can await later)
 * - dispatch: Fire-and-forget (no waiting)
 * - transfer: Full handoff (original agent exits)
 *
 * Run: npx tsx examples/dynamicFlow.ts
 */

import { z } from 'zod';
import {
  agent,
  tool,
  openai,
  injectSystemMessage,
  includeHistory,
  excludeChildInvocationEvents,
  cli,
} from '../src';


const pythonAgent = agent({
  name: 'python_agent',
  description: 'Expert at writing and executing Python code',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(
      'You are a Python expert. Write code to solve problems and use the execute_python tool to run it. Be brief.',
    ),
    includeHistory({ scope: 'invocation' }),
  ],
  tools: [
    tool({
      name: 'execute_python',
      description: 'Execute Python code and return the output',
      schema: z.object({ code: z.string() }),
      execute: (ctx) => ({
        output: `[Mock execution]\nCode executed:\n${ctx.args.code}\n\nOutput: Success`,
      }),
    }),
  ],
});

const researchAgent = agent({
  name: 'research_agent',
  description: 'Research agent for background tasks',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(
      'You are a research agent. Analyze the topic and provide insights. Be brief.',
    ),
    includeHistory({ scope: 'invocation' }),
  ],
});

const specialistAgent = agent({
  name: 'specialist_agent',
  description: 'Specialist that handles complex queries',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(
      `You are a specialist agent that received a transfer.
Provide a response to the query. Be brief.
You have full control now - the original agent has handed off to you.`,
    ),
    includeHistory(),
    excludeChildInvocationEvents(),
  ],
});

const callPython = tool({
  name: 'python_agent',
  description: 'Call Python expert for code execution (sync, waits for result)',
  schema: z.object({
    task: z.string().describe('Task for the Python expert'),
  }),
  execute: async (ctx) => {
    const result = await ctx.call(pythonAgent, { message: ctx.args.task });
    return result.output;
  },
});

const spawnResearch = tool({
  name: 'spawn_research',
  description: 'Spawn research agent in background (async, can await later)',
  schema: z.object({
    topic: z.string().describe('Research topic'),
  }),
  execute: (ctx) => {
    const handle = ctx.spawn(researchAgent, { message: ctx.args.topic });
    return {
      status: 'spawned',
      invocationId: handle.invocationId,
      agent: handle.agentName,
    };
  },
});

const dispatchResearch = tool({
  name: 'dispatch_research',
  description: 'Dispatch research agent (fire-and-forget, no waiting)',
  schema: z.object({
    topic: z.string().describe('Research topic'),
  }),
  execute: (ctx) => {
    const handle = ctx.dispatch(researchAgent, { message: ctx.args.topic });
    return {
      status: 'dispatched',
      invocationId: handle.invocationId,
      agent: handle.agentName,
    };
  },
});

const transferToSpecialist = tool({
  name: 'transfer_to_specialist',
  description: 'Transfer complete control to specialist',
  schema: z.object({
    info: z.string().describe('Context for specialist'),
  }),
  execute: (ctx) => {
    ctx.state.transferContext = ctx.args.info;
    return specialistAgent;
  },
});

const coordinator = agent({
  name: 'coordinator',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(
      `You are a coordinator with four orchestration patterns. Be brief.

1. **python_agent**: Synchronous call - for Python code execution
2. **spawn_research**: Async spawn - for background analysis
3. **dispatch_research**: Fire-and-forget dispatch
4. **transfer_to_specialist**: Full handoff - you will NOT continue after

For this demo:
- Python code questions → call python_agent
- Background research → spawn_research or dispatch_research
- Complex queries → transfer_to_specialist`,
    ),
    includeHistory(),
    excludeChildInvocationEvents(),
  ],
  tools: [callPython, spawnResearch, dispatchResearch, transferToSpecialist],
});

const query =
  'Research special relativity, and write a Python function to simulate it. When complete, transfer to a specialist to explain it.';

cli(coordinator, query);
