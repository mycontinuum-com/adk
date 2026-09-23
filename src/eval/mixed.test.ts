import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

import type { VoiceRunResult } from './voice/types'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { serializeEvent, stringifyEvidence } from './json'
import { createEvalSession } from './session'
import { serializeWorkerResult } from './voice/evaluate'
import { forkCase } from './voice/process-pool'
import { runVoiceCase } from './voice/runner'

vi.mock('./voice/runner', () => ({ runVoiceCase: vi.fn<typeof runVoiceCase>() }))
vi.mock('./voice/process-pool', () => ({
  isProcessWorker: () => false,
  forkCase: vi.fn<typeof forkCase>(),
  getWorkerCaseIndex: () => 0,
  sendWorkerResult: vi.fn<() => Promise<void>>(),
}))

function voiceRun(): VoiceRunResult {
  return {
    status: 'completed',
    startedAtMs: 0,
    session: createEvalSession(),
    events: [],
    voiceEvents: [],
    transcript: [{ role: 'assistant', text: 'Hello by voice', turnIndex: 0 }],
    timing: {
      responseTimes: [],
      silenceGaps: [],
      interruptions: { count: 0, byAgent: 0, byUser: 0 },
      vadResolutionMs: 0,
    },
    recording: { path: '' },
    durationMs: 1,
  }
}

beforeEach(() => {
  vi.mocked(runVoiceCase).mockReset().mockResolvedValue(voiceRun())
  vi.mocked(forkCase).mockReset()
})

function fixture() {
  const app = adk()
  const agent = app.agent({ name: 'voice', model: openai('unused'), context: [] })
  const text = app.evaluate.case({
    name: 'text',
    runnable: app.step({ name: 'hello', execute: (ctx) => ctx.output('Hello by text') }),
    metrics: [{ name: 'text-check', evaluate: () => ({ passed: true }) }],
  })
  const voice = app.evaluate.voice.case({
    name: 'voice',
    agent,
    userAgent: agent,
    metrics: [
      {
        name: 'voice-check',
        evaluate: (run) => ({ passed: run.transcript[0]?.text === 'Hello by voice' }),
      },
    ],
  })
  return { app, text, voice }
}

it('evaluates mixed cases with repeat metadata, mode-specific metrics and one report', async () => {
  const { app, text, voice } = fixture()
  const progress: string[] = []
  const result = await app.evaluate([text, voice], {
    concurrency: 1,
    repeat: 2,
    voice: { room: { url: 'ws://unused' } },
    onCase: (item, index, total) => progress.push(`${item.name}:${index}/${total}`),
  })
  expect(result.summary).toEqual({
    total: 4,
    passed: 4,
    failed: 0,
    errors: 0,
    terminated: 0,
    aborted: 0,
    timedOut: 0,
  })
  expect(
    result.results.map((item) => [item.name, item.repeatIndex, Object.keys(item.metrics)]),
  ).toEqual([
    ['text', 1, ['text-check']],
    ['text', 2, ['text-check']],
    ['voice', 1, ['voice-check']],
    ['voice', 2, ['voice-check']],
  ])
  expect(progress).toEqual(['text:1/4', 'text:2/4', 'voice:3/4', 'voice:4/4'])
  expect(app.evaluate.report()(result)).toContain('100.000% (4/4)')
})

it('gives colliding names and dot segments separate evidence directories', async () => {
  const { app, voice } = fixture()
  const root = await mkdtemp(join(tmpdir(), 'adk-voice-paths-'))
  const output = join(root, 'voice')
  await app.evaluate(
    ['greeting/en', 'greeting:en', '..'].map((name) => ({ ...voice, name })),
    {
      concurrency: 1,
      repeat: 2,
      output,
      voice: { room: { url: 'ws://unused' } },
    },
  )
  expect((await readdir(output)).sort()).toEqual([
    '1-greeting_en',
    '2-greeting_en',
    '3-greeting_en',
    '4-greeting_en',
    '5-..',
    '6-..',
    'index.md',
  ])
  expect(await readdir(root)).toEqual(['voice'])
  expect(await readFile(join(output, '1-greeting_en', 'report.md'), 'utf8')).toContain(
    'greeting/en',
  )
  expect(await readFile(join(output, '3-greeting_en', 'report.md'), 'utf8')).toContain(
    'greeting:en',
  )
})

it('preserves a nonempty output directory', async () => {
  const { app, voice } = fixture()
  const output = await mkdtemp(join(tmpdir(), 'adk-voice-existing-'))
  await writeFile(join(output, 'keep.txt'), 'keep')
  await expect(
    app.evaluate([voice], { output, voice: { room: { url: 'ws://unused' } } }),
  ).rejects.toThrow('output directory must be empty')
  expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('keep')
})

it('shares a concurrency budget across text and voice, retaining in-flight results after failure', async () => {
  const { app, text, voice } = fixture()
  let active = 0
  let peak = 0
  const wait = async () => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => setTimeout(resolve, 30))
    active--
  }
  vi.mocked(forkCase).mockImplementation(async () => {
    await wait()
    return serializeWorkerResult({
      name: 'voice',
      status: 'failed',
      metrics: {},
      run: voiceRun(),
      durationMs: 30,
    })
  })
  const slowText = {
    ...text,
    runnable: app.step({
      name: 'slow',
      execute: async (ctx) => {
        await wait()
        return ctx.output('done')
      },
    }),
  }
  const result = await app.evaluate([voice, slowText, { ...text, name: 'not-started' }], {
    concurrency: 2,
    stopOnFirstFailure: true,
    voice: { room: { url: 'ws://unused' } },
  })
  expect(peak).toBe(2)
  expect(result.results.map((item) => [item.name, item.status])).toEqual([
    ['voice', 'failed'],
    ['text', 'passed'],
  ])
})

it('rejects lossy voice metric data before worker serialization', async () => {
  const { app, voice } = fixture()
  await expect(
    app.evaluate(
      [
        {
          ...voice,
          metrics: [
            {
              name: 'invalid',
              evaluate: () => ({ passed: true, data: { lost: new Map([['key', 'value']]) } }),
            },
          ],
        },
      ],
      { concurrency: 1, voice: { room: { url: 'ws://unused' } } },
    ),
  ).rejects.toThrow('plain JSON objects')
  expect(() => stringifyEvidence({ score: NaN })).toThrow('non-finite number')
  expect(() => stringifyEvidence({ metric: { dropped: undefined } })).toThrow('undefined')
  expect(() => stringifyEvidence({ metric: { values: [undefined] } })).toThrow('undefined')
  expect(
    stringifyEvidence(
      serializeEvent({
        type: 'state_change',
        changes: [{ key: 'greeted', oldValue: undefined, newValue: true }],
      }),
    ),
  ).toContain('"newValue": true')
  expect(stringifyEvidence({ evidence: ['kept'], data: { count: 2 } })).toBe(
    '{\n  "evidence": [\n    "kept"\n  ],\n  "data": {\n    "count": 2\n  }\n}',
  )
})

it.each(['not json', '{}', '{"run":null}'])(
  'records invalid worker result %s as a case error and retains text results',
  async (raw) => {
    const { app, text, voice } = fixture()
    vi.mocked(forkCase).mockResolvedValue(raw)
    const result = await app.evaluate([voice, text], {
      concurrency: 2,
      voice: { room: { url: 'ws://unused' } },
    })
    expect(result.results.map((item) => [item.name, item.status])).toEqual([
      ['voice', 'error'],
      ['text', 'passed'],
    ])
    expect(result.results[0].error?.message).toContain('invalid evaluation result')
    expect(result.summary.errors).toBe(1)
  },
)

it('rejects a non-JSON event before voice worker IPC', () => {
  expect(() =>
    serializeWorkerResult({
      name: 'voice',
      status: 'passed',
      metrics: {},
      run: {
        ...voiceRun(),
        events: [{ result: new Map([['key', 'value']]) }] as never,
      },
      durationMs: 1,
    }),
  ).toThrow('plain JSON objects')
})
