/**
 * Dynamic Orchestration Example
 *
 * Demonstrates the four dynamic orchestration patterns: - run: Synchronous run of another agent
 * (waits for result) - spawn: Asynchronous spawn (can await later) - dispatch: Fire-and-forget (no
 * waiting) - transfer: Full handoff (original agent exits)
 *
 * Run: npx tsx examples/dynamicFlow.ts
 */

import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk({
  schema: {
    session: {
      transferContext: z.string().optional(),
    },
  },
})

const executePython = app.tool({
  name: 'execute_python',
  description: 'Execute Python code and return the output',
  schema: z.object({ code: z.string() }),
  execute: (ctx) => ({
    output: `[Mock execution]\nCode executed:\n${ctx.args.code}\n\nOutput: Success`,
  }),
})

const pythonAgent = app.agent({
  name: 'python_agent',
  description: 'Expert at writing and executing Python code',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      'You are a Python expert. Write code to solve problems and use the execute_python tool to run it. Be brief.',
    ),
    app.context.history({ scope: 'invocation' }),
  ],
  tools: [executePython],
})

const researchAgent = app.agent({
  name: 'research_agent',
  description: 'Research agent for background tasks',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      'You are a research agent. Analyze the topic and provide insights. Be brief.',
    ),
    app.context.history({ scope: 'invocation' }),
  ],
})

const specialistAgent = app.agent({
  name: 'specialist_agent',
  description: 'Specialist that handles complex queries',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      `You are a specialist agent that received a transfer.
Provide a response to the query. Be brief.
You have full control now - the original agent has handed off to you.`,
    ),
    app.context.history(),
  ],
})

const runPython = app.tool({
  name: 'python_agent',
  description: 'Run Python expert for code execution (sync, waits for result)',
  schema: z.object({
    task: z.string().describe('Task for the Python expert'),
  }),
  execute: async (ctx) => {
    const result = await ctx.run(pythonAgent, ctx.args.task)
    return result.output.text
  },
})

const spawnResearch = app.tool({
  name: 'spawn_research',
  description: 'Spawn research agent in background (async, can await later)',
  schema: z.object({
    topic: z.string().describe('Research topic'),
  }),
  execute: (ctx) => {
    const handle = ctx.spawn(researchAgent, ctx.args.topic)
    return {
      status: 'spawned',
      invocationId: handle.invocationId,
      agent: handle.agentName,
    }
  },
})

const dispatchResearch = app.tool({
  name: 'dispatch_research',
  description: 'Dispatch research agent (fire-and-forget, no waiting)',
  schema: z.object({
    topic: z.string().describe('Research topic'),
  }),
  execute: (ctx) => {
    const handle = ctx.dispatch(researchAgent, ctx.args.topic)
    return {
      status: 'dispatched',
      invocationId: handle.invocationId,
      agent: handle.agentName,
    }
  },
})

const transferToSpecialist = app.tool({
  name: 'transfer_to_specialist',
  description: 'Transfer complete control to specialist',
  schema: z.object({
    info: z.string().describe('Context for specialist'),
  }),
  execute: (ctx) => {
    ctx.state.transferContext = ctx.args.info
    return specialistAgent
  },
})

const coordinator = app.agent({
  name: 'coordinator',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      `You are a coordinator with four orchestration patterns. Be brief.

1. **python_agent**: Synchronous run - for Python code execution
2. **spawn_research**: Async spawn - for background analysis
3. **dispatch_research**: Fire-and-forget dispatch
4. **transfer_to_specialist**: Full handoff - you will NOT continue after

For this demo:
- Python code questions → call python_agent
- Background research → spawn_research or dispatch_research
- Complex queries → transfer_to_specialist`,
    ),
    app.context.history(),
  ],
  tools: [runPython, spawnResearch, dispatchResearch, transferToSpecialist],
})

const query =
  'Research special relativity, and write a Python function to simulate it. When complete, transfer to a specialist to explain it.'

app.cli(coordinator, query)
