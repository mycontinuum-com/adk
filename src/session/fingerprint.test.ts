import { z } from 'zod';
import { computePipelineFingerprint } from './fingerprint';
import { agent, sequence, parallel, loop, step, tool } from '../index';
import { openai } from '../providers';

describe('computePipelineFingerprint', () => {
  const model = openai('gpt-4o-mini');

  describe('basic fingerprinting', () => {
    test('returns consistent fingerprint for same agent', () => {
      const myAgent = agent({
        name: 'test_agent',
        model,
        context: [],
        tools: [],
      });

      const fp1 = computePipelineFingerprint(myAgent);
      const fp2 = computePipelineFingerprint(myAgent);

      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(16);
    });

    test('different names produce different fingerprints', () => {
      const agent1 = agent({ name: 'agent_a', model, context: [], tools: [] });
      const agent2 = agent({ name: 'agent_b', model, context: [], tools: [] });

      expect(computePipelineFingerprint(agent1)).not.toBe(
        computePipelineFingerprint(agent2),
      );
    });

    test('different tools produce different fingerprints', () => {
      const tool1 = tool({
        name: 'tool_one',
        description: 'First tool',
        schema: z.object({}),
        execute: () => ({}),
      });
      const tool2 = tool({
        name: 'tool_two',
        description: 'Second tool',
        schema: z.object({}),
        execute: () => ({}),
      });

      const agentWithTool1 = agent({
        name: 'test_agent',
        model,
        context: [],
        tools: [tool1],
      });
      const agentWithTool2 = agent({
        name: 'test_agent',
        model,
        context: [],
        tools: [tool2],
      });

      expect(computePipelineFingerprint(agentWithTool1)).not.toBe(
        computePipelineFingerprint(agentWithTool2),
      );
    });

    test('tool order does not affect fingerprint (tools are sorted)', () => {
      const toolA = tool({
        name: 'a_tool',
        description: 'A',
        schema: z.object({}),
        execute: () => ({}),
      });
      const toolB = tool({
        name: 'b_tool',
        description: 'B',
        schema: z.object({}),
        execute: () => ({}),
      });

      const agentAB = agent({
        name: 'test_agent',
        model,
        context: [],
        tools: [toolA, toolB],
      });
      const agentBA = agent({
        name: 'test_agent',
        model,
        context: [],
        tools: [toolB, toolA],
      });

      expect(computePipelineFingerprint(agentAB)).toBe(
        computePipelineFingerprint(agentBA),
      );
    });
  });

  describe('sequence fingerprinting', () => {
    test('sequence fingerprint includes child order', () => {
      const agentA = agent({ name: 'agent_a', model, context: [], tools: [] });
      const agentB = agent({ name: 'agent_b', model, context: [], tools: [] });

      const seqAB = sequence({
        name: 'seq',
        runnables: [agentA, agentB],
      });
      const seqBA = sequence({
        name: 'seq',
        runnables: [agentB, agentA],
      });

      expect(computePipelineFingerprint(seqAB)).not.toBe(
        computePipelineFingerprint(seqBA),
      );
    });

    test('nested sequences produce distinct fingerprints', () => {
      const agentA = agent({ name: 'agent_a', model, context: [], tools: [] });
      const agentB = agent({ name: 'agent_b', model, context: [], tools: [] });

      const innerSeq = sequence({
        name: 'inner',
        runnables: [agentA],
      });
      const outerSeq = sequence({
        name: 'outer',
        runnables: [innerSeq, agentB],
      });

      const flatSeq = sequence({
        name: 'outer',
        runnables: [agentA, agentB],
      });

      expect(computePipelineFingerprint(outerSeq)).not.toBe(
        computePipelineFingerprint(flatSeq),
      );
    });
  });

  describe('parallel fingerprinting', () => {
    test('parallel fingerprint includes child order', () => {
      const agentA = agent({ name: 'agent_a', model, context: [], tools: [] });
      const agentB = agent({ name: 'agent_b', model, context: [], tools: [] });

      const parAB = parallel({
        name: 'par',
        runnables: [agentA, agentB],
      });
      const parBA = parallel({
        name: 'par',
        runnables: [agentB, agentA],
      });

      expect(computePipelineFingerprint(parAB)).not.toBe(
        computePipelineFingerprint(parBA),
      );
    });
  });

  describe('loop fingerprinting', () => {
    test('loop fingerprint includes inner runnable', () => {
      const agentA = agent({ name: 'agent_a', model, context: [], tools: [] });
      const agentB = agent({ name: 'agent_b', model, context: [], tools: [] });

      const loopA = loop({
        name: 'loop',
        runnable: agentA,
        maxIterations: 10,
        while: () => false,
      });
      const loopB = loop({
        name: 'loop',
        runnable: agentB,
        maxIterations: 10,
        while: () => false,
      });

      expect(computePipelineFingerprint(loopA)).not.toBe(
        computePipelineFingerprint(loopB),
      );
    });

    test('yields flag affects fingerprint', () => {
      const innerAgent = agent({
        name: 'inner',
        model,
        context: [],
        tools: [],
      });

      const loopYields = loop({
        name: 'loop',
        runnable: innerAgent,
        maxIterations: 10,
        while: () => false,
        yields: true,
      });
      const loopNoYields = loop({
        name: 'loop',
        runnable: innerAgent,
        maxIterations: 10,
        while: () => false,
        yields: false,
      });

      expect(computePipelineFingerprint(loopYields)).not.toBe(
        computePipelineFingerprint(loopNoYields),
      );
    });
  });

  describe('step fingerprinting', () => {
    test('step fingerprint is based on name', () => {
      const step1 = step({
        name: 'step_one',
        execute: async () => ({ signal: 'complete' as const, value: null }),
      });
      const step2 = step({
        name: 'step_two',
        execute: async () => ({ signal: 'complete' as const, value: null }),
      });

      expect(computePipelineFingerprint(step1)).not.toBe(
        computePipelineFingerprint(step2),
      );
    });
  });
});
