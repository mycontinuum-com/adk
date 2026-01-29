import {
  runTest,
  user,
  model,
  mockAgent,
  testAgent,
  setupAdkMatchers,
} from '../testing';
import { sequence, parallel } from './index';

setupAdkMatchers();

describe('sequence composition', () => {
  test('tests sequence execution order', async () => {
    const step1 = testAgent({ name: 'step1' });
    const step2 = testAgent({ name: 'step2' });

    const pipeline = sequence({
      name: 'pipeline',
      runnables: [step1, step2],
    });

    const { events } = await runTest(pipeline, [
      user('Start'),
      model({ text: 'Step 1 complete' }),
      model({ text: 'Step 2 complete' }),
    ]);

    expect(events).toHaveAssistantText('Step 2 complete');
  });

  test('tests sequence with analyzer and summarizer', async () => {
    const analyzer = testAgent({ name: 'analyzer' });
    const summarizer = testAgent({ name: 'summarizer' });

    const pipeline = sequence({
      name: 'pipeline',
      runnables: [analyzer, summarizer],
    });

    const { events } = await runTest(pipeline, [
      user('Analyze and summarize'),
      model({ text: 'Analysis done' }),
      model({ text: 'Summary complete' }),
    ]);

    expect(events).toHaveAssistantText('Summary complete');
  });

  test('verifies sequence execution order via events', async () => {
    const step1 = testAgent({ name: 'first' });
    const step2 = testAgent({ name: 'second' });

    const pipeline = sequence({
      name: 'pipeline',
      runnables: [step1, step2],
    });

    const { events } = await runTest(pipeline, [
      user('Go'),
      model({ text: 'First' }),
      model({ text: 'Second' }),
    ]);

    const starts = [...events].filter((e) => e.type === 'invocation_start');
    const agentNames = starts.map((e) =>
      e.type === 'invocation_start' ? e.agentName : null,
    );

    expect(agentNames).toContain('first');
    expect(agentNames).toContain('second');
    expect(agentNames.indexOf('first')).toBeLessThan(
      agentNames.indexOf('second'),
    );
  });

  test('uses mockAgent to test orchestration', async () => {
    const mockAnalyzer = mockAgent('analyzer', {
      responses: [{ text: 'Mock analysis complete' }],
    });

    const mockSummarizer = mockAgent('summarizer', {
      responses: [{ text: 'Mock summary complete' }],
    });

    const pipeline = sequence({
      name: 'pipeline',
      runnables: [mockAnalyzer, mockSummarizer],
    });

    const { events } = await runTest(pipeline, [user('Process')]);

    const assistantTexts = [...events]
      .filter((e) => e.type === 'assistant')
      .map((e) => (e as { text: string }).text);

    expect(assistantTexts).toContain('Mock analysis complete');
    expect(assistantTexts).toContain('Mock summary complete');
  });

  test('tests nested sequence in parallel', async () => {
    const step1 = mockAgent('step1', { responses: [{ text: 'Inner step 1' }] });
    const step2 = mockAgent('step2', { responses: [{ text: 'Inner step 2' }] });

    const innerSeq = sequence({
      name: 'inner',
      runnables: [step1, step2],
    });

    const outerParallel = parallel({
      name: 'outer',
      runnables: [
        innerSeq,
        mockAgent('other', { responses: [{ text: 'Other branch' }] }),
      ],
    });

    const { status } = await runTest(outerParallel, [user('Go')]);

    expect(status).toBe('completed');
  });
});
