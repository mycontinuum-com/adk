import { z } from 'zod';
import {
  runTest,
  user,
  model,
  input,
  testAgent,
  setupAdkMatchers,
} from '../testing';
import { agent } from '../agents';
import { tool } from './index';
import { openai } from '../providers';
import { includeHistory, injectSystemMessage } from '../context';
import type {
  InvocationStartEvent,
  InvocationEndEvent,
  ToolResultEvent,
} from '../types';

setupAdkMatchers();

const createMathExpert = () =>
  agent({
    name: 'math_expert',
    model: openai('gpt-4o-mini'),
    context: [
      injectSystemMessage('Math expert.'),
      includeHistory({ scope: 'invocation' }),
    ],
  });

const createSpecialist = () =>
  agent({
    name: 'specialist',
    model: openai('gpt-4o-mini'),
    context: [injectSystemMessage('Specialist.'), includeHistory()],
  });

const createResearchAgent = () =>
  agent({
    name: 'research_agent',
    model: openai('gpt-4o-mini'),
    context: [
      injectSystemMessage('Research agent.'),
      includeHistory({ scope: 'invocation' }),
    ],
  });

const createCallTool = (targetAgent: ReturnType<typeof createMathExpert>) =>
  tool({
    name: targetAgent.name,
    description: `Call ${targetAgent.name}`,
    schema: z.object({ task: z.string() }),
    execute: async (ctx) => {
      const result = await ctx.call(targetAgent, { message: ctx.args.task });
      return {
        agent: targetAgent.name,
        status: result.status,
        output: result.output,
      };
    },
  });

const createTransferTool = (targetAgent: ReturnType<typeof createSpecialist>) =>
  tool({
    name: `transfer_to_${targetAgent.name}`,
    description: `Transfer to ${targetAgent.name}`,
    schema: z.object({ info: z.string() }),
    execute: (ctx) => {
      ctx.state.set('transferContext', ctx.args.info);
      return targetAgent;
    },
  });

const createSpawnTool = (targetAgent: ReturnType<typeof createResearchAgent>) =>
  tool({
    name: `spawn_${targetAgent.name}`,
    description: `Spawn ${targetAgent.name}`,
    schema: z.object({ topic: z.string() }),
    execute: (ctx) => {
      const handle = ctx.spawn(targetAgent, { message: ctx.args.topic });
      return {
        agent: targetAgent.name,
        invocationId: handle.invocationId,
        status: 'spawned',
      };
    },
  });

const createDispatchTool = (
  targetAgent: ReturnType<typeof createResearchAgent>,
) =>
  tool({
    name: `dispatch_${targetAgent.name}`,
    description: `Dispatch ${targetAgent.name}`,
    schema: z.object({ topic: z.string() }),
    execute: (ctx) => {
      const handle = ctx.dispatch(targetAgent, { message: ctx.args.topic });
      return {
        agent: targetAgent.name,
        invocationId: handle.invocationId,
        status: 'dispatched',
      };
    },
  });

describe('call pattern', () => {
  test('calls synchronously and emits proper events', async () => {
    const mathExpert = createMathExpert();
    const coordinator = testAgent({
      name: 'coordinator',
      tools: [createCallTool(mathExpert)],
    });

    const { events, status } = await runTest(coordinator, [
      user('Calculate 2 + 2'),
      model({
        toolCalls: [{ name: 'math_expert', args: { task: 'Calculate 2 + 2' } }],
      }),
      model({ text: '2 + 2 = 4' }),
      model({ text: 'The answer is 4' }),
    ]);

    expect(status).toBe('completed');

    const starts = [...events].filter(
      (e) => e.type === 'invocation_start',
    ) as InvocationStartEvent[];
    const ends = [...events].filter(
      (e) => e.type === 'invocation_end',
    ) as InvocationEndEvent[];
    const callStart = starts.find(
      (e) => e.agentName === 'math_expert' && e.handoffOrigin?.type === 'call',
    );
    const callEnd = ends.find((e) => e.agentName === 'math_expert');

    expect(callStart?.handoffOrigin?.type).toBe('call');
    expect(callStart?.parentInvocationId).toBe(
      starts.find((e) => e.agentName === 'coordinator')?.invocationId,
    );
    expect(callEnd?.reason).toBe('completed');

    const toolResults = [...events].filter(
      (e) => e.type === 'tool_result',
    ) as ToolResultEvent[];
    expect(
      toolResults.find((r) => r.name === 'math_expert')?.result,
    ).toMatchObject({
      agent: 'math_expert',
      status: 'completed',
    });
  });

  test('propagates yields from called agent and resumes correctly', async () => {
    const yieldingTool = tool({
      name: 'confirm',
      description: 'Confirm action',
      schema: z.object({ action: z.string() }),
      yieldSchema: z.object({ confirmed: z.boolean() }),
      execute: (ctx) => ({
        action: ctx.args.action,
        confirmed: ctx.input?.confirmed ?? false,
      }),
    });

    const yieldingExpert = agent({
      name: 'yielding_expert',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [yieldingTool],
    });

    const callYielding = tool({
      name: 'yielding_expert',
      description: 'Call yielding expert',
      schema: z.object({ task: z.string() }),
      execute: async (ctx) => {
        const result = await ctx.call(yieldingExpert, {
          message: ctx.args.task,
        });
        return { agent: 'yielding_expert', status: result.status };
      },
    });

    const coordWithYielding = testAgent({
      tools: [callYielding],
    });

    const { status } = await runTest(coordWithYielding, [
      user('Need confirmation'),
      model({
        toolCalls: [
          { name: 'yielding_expert', args: { task: 'Confirm this' } },
        ],
      }),
      model({
        toolCalls: [{ name: 'confirm', args: { action: 'proceed' } }],
      }),
      input({ confirm: { confirmed: true } }),
      model({ text: 'Confirmed by expert' }),
      model({ text: 'Done' }),
    ]);

    expect(status).toBe('completed');
  });
});

describe('transfer pattern', () => {
  test('transfers control and emits proper events', async () => {
    const specialist = createSpecialist();
    const triage = testAgent({
      name: 'triage',
      tools: [createTransferTool(specialist)],
    });

    const { events, status } = await runTest(triage, [
      user('Complex query'),
      model({
        toolCalls: [
          {
            name: 'transfer_to_specialist',
            args: { info: 'Handle this' },
          },
        ],
      }),
      model({ text: 'Specialist handling your query' }),
    ]);

    expect(events).toHaveAssistantText(/Specialist/);
    expect(status).toBe('completed');

    const starts = [...events].filter(
      (e) => e.type === 'invocation_start',
    ) as InvocationStartEvent[];
    const ends = [...events].filter(
      (e) => e.type === 'invocation_end',
    ) as InvocationEndEvent[];

    const triageEnd = ends.find((e) => e.agentName === 'triage');
    const specialistStart = starts.find((e) => e.agentName === 'specialist');

    expect(triageEnd?.reason).toBe('transferred');
    expect(triageEnd?.handoffTarget?.agentName).toBe('specialist');
    expect(specialistStart?.handoffOrigin?.type).toBe('transfer');

    const assistantEvents = [...events].filter((e) => e.type === 'assistant');
    expect(assistantEvents).toHaveLength(1);

    const toolResults = [...events].filter(
      (e) => e.type === 'tool_result',
    ) as ToolResultEvent[];
    expect(
      toolResults.find((r) => r.name === 'transfer_to_specialist')?.result,
    ).toMatchObject({
      transfer: true,
      agent: 'specialist',
    });
  });

  test('passes transfer context via state', async () => {
    const specialist = createSpecialist();
    const triage = testAgent({
      name: 'triage',
      tools: [createTransferTool(specialist)],
    });

    const { session } = await runTest(triage, [
      user('Medical question'),
      model({
        toolCalls: [
          {
            name: 'transfer_to_specialist',
            args: { info: 'Rare genetic conditions' },
          },
        ],
      }),
      model({ text: 'Specialist response' }),
    ]);

    expect(session.state.session.get('transferContext')).toBe(
      'Rare genetic conditions',
    );
  });
});

describe('spawn pattern', () => {
  test('spawns and returns immediately with proper events', async () => {
    const researchAgent = createResearchAgent();
    const coordinator = testAgent({
      tools: [createSpawnTool(researchAgent)],
    });

    const { events, status } = await runTest(coordinator, [
      user('Research topic'),
      model({
        toolCalls: [
          {
            name: 'spawn_research_agent',
            args: { topic: 'Research this' },
          },
        ],
      }),
      model({ text: 'Research started' }),
      model({ text: 'Done' }),
    ]);

    expect(status).toBe('completed');

    const starts = [...events].filter(
      (e) => e.type === 'invocation_start',
    ) as InvocationStartEvent[];
    const spawnStart = starts.find(
      (e) =>
        e.agentName === 'research_agent' && e.handoffOrigin?.type === 'spawn',
    );

    expect(spawnStart?.handoffOrigin?.type).toBe('spawn');

    const toolResults = [...events].filter(
      (e) => e.type === 'tool_result',
    ) as ToolResultEvent[];
    expect(
      toolResults.find((r) => r.name === 'spawn_research_agent')?.result,
    ).toMatchObject({
      agent: 'research_agent',
      status: 'spawned',
    });
  });
});

describe('dispatch pattern', () => {
  test('dispatches fire-and-forget with proper events', async () => {
    const researchAgent = createResearchAgent();
    const coordinator = testAgent({
      tools: [createDispatchTool(researchAgent)],
    });

    const { events, status } = await runTest(coordinator, [
      user('Research topic'),
      model({
        toolCalls: [
          {
            name: 'dispatch_research_agent',
            args: { topic: 'Research this' },
          },
        ],
      }),
      model({ text: 'Research dispatched' }),
      model({ text: 'Done' }),
    ]);

    expect(status).toBe('completed');

    const starts = [...events].filter(
      (e) => e.type === 'invocation_start',
    ) as InvocationStartEvent[];
    const dispatchStart = starts.find(
      (e) =>
        e.agentName === 'research_agent' &&
        e.handoffOrigin?.type === 'dispatch',
    );

    expect(dispatchStart?.handoffOrigin?.type).toBe('dispatch');

    const toolResults = [...events].filter(
      (e) => e.type === 'tool_result',
    ) as ToolResultEvent[];
    expect(
      toolResults.find((r) => r.name === 'dispatch_research_agent')?.result,
    ).toMatchObject({
      agent: 'research_agent',
      status: 'dispatched',
    });
  });
});

describe('multiple orchestrations', () => {
  test('coordinator can use multiple call tools sequentially', async () => {
    const mathAgent = agent({
      name: 'math',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    });
    const writingAgent = agent({
      name: 'writing',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    });

    const coordinator = testAgent({
      tools: [createCallTool(mathAgent), createCallTool(writingAgent)],
    });

    const { events } = await runTest(coordinator, [
      user('Math then writing'),
      model({
        toolCalls: [{ name: 'math', args: { task: 'Calculate' } }],
      }),
      model({ text: 'Math result' }),
      model({
        toolCalls: [{ name: 'writing', args: { task: 'Write' } }],
      }),
      model({ text: 'Writing result' }),
      model({ text: 'Both done' }),
    ]);

    const toolResults = [...events].filter(
      (e) => e.type === 'tool_result',
    ) as ToolResultEvent[];
    expect(toolResults.find((r) => r.name === 'math')?.result).toMatchObject({
      agent: 'math',
    });
    expect(toolResults.find((r) => r.name === 'writing')?.result).toMatchObject(
      { agent: 'writing' },
    );
  });
});
