import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const fixture = resolve(import.meta.dirname, '../test-support/eval-cli.ts')

async function invoke(args: string[], env: Record<string, string> = {}) {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', fixture, ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    })
    return { ...result, code: 0 }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stdout' in error &&
      'stderr' in error &&
      'code' in error
    ) {
      return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code }
    }
    throw error
  }
}

it('lists both kinds without opening voice connections or executing text', async () => {
  const result = await invoke(['list'], { EVAL_TEST_MIXED: '1' })
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).cases).toEqual([
    { name: 'greeting/text', kind: 'text' },
    { name: 'greeting/voice', kind: 'voice' },
  ])
  expect(result.stderr).toBe('')
})

it('selects text from a mixed suite, repeats it, and saves matching JSON plus conversation evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const result = await invoke(
    ['run', '--case', 'greeting/text', '--repeat', '2', '--output', root],
    { EVAL_TEST_MIXED: '1' },
  )
  expect(result.code).toBe(0)
  const document = JSON.parse(result.stdout)
  expect(document.selected).toEqual(['greeting/text'])
  expect(document.expected).toBe(2)
  expect(document.completed).toBe(2)
  expect(
    document.results.map((item: { status: string; repeatIndex: number }) => [
      item.status,
      item.repeatIndex,
    ]),
  ).toEqual([
    ['passed', 1],
    ['passed', 2],
  ])
  expect(result.stderr).toContain('text diagnostic')
  expect(JSON.parse(await readFile(join(document.directory, 'result.json'), 'utf8'))).toEqual(
    document,
  )
  expect(await readFile(document.results[0].evidence, 'utf8')).toContain('Hello from the text case')
  expect(await readFile(document.report, 'utf8')).toContain('Eval Report')
  const next = await invoke(['run', '--output', root])
  expect(next.code).toBe(0)
  expect(await readdir(root)).toHaveLength(2)
  expect(JSON.parse(await readFile(join(document.directory, 'result.json'), 'utf8'))).toEqual(
    document,
  )
})

it('returns failure for a failed metric and invocation error for an unknown case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const failed = await invoke(['run', '--output', root], { EVAL_TEST_FAIL: '1' })
  expect(failed.code).toBe(1)
  expect(JSON.parse(failed.stdout).summary.failed).toBe(1)
  const invalid = await invoke(['run', '--case', 'missing', '--output', root])
  expect(invalid.code).toBe(2)
  expect(JSON.parse(invalid.stdout).error.message).toBe('Unknown case: missing')
})

it('collects a real voice-worker setup failure without executing text again in the worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-worker-'))
  const counter = join(root, 'counter.txt')
  const result = await invoke(['run', '--output', root], {
    EVAL_TEST_MIXED: '1',
    EVAL_TEST_COUNTER: counter,
  })
  expect(result.code).toBe(1)
  const document = JSON.parse(result.stdout)
  expect(
    document.results.map((item: { name: string; status: string }) => [item.name, item.status]),
  ).toEqual([
    ['greeting/text', 'passed'],
    ['greeting/voice', 'error'],
  ])
  expect(await readFile(counter, 'utf8')).toBe('text\n')
  expect(result.stderr).toContain('must have a realtime model config')
  expect(document.completed).toBe(2)
})

it('runs each named case of several, in suite order, and names every unknown one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const args = ['run', '--output', root, '--case', 'greeting/voice', '--case', 'greeting/text']
  const both = await invoke(args, { EVAL_TEST_MIXED: '1' })
  expect(JSON.parse(both.stdout).selected).toEqual(['greeting/text', 'greeting/voice'])
  const unknown = await invoke([...args, '--case', 'missing'])
  expect(unknown.code).toBe(2)
  expect(JSON.parse(unknown.stdout).error.message).toBe('Unknown case: greeting/voice, missing')
})

it('compares with pooled baselines: a regressed case, and a tool result no check looked at', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const run = (args: string[], env: Record<string, string> = {}) =>
    invoke(['run', '--repeat', '5', '--output', root, ...args], { EVAL_TEST_AGENT: '1', ...env })
  const first = JSON.parse((await run([])).stdout)
  const second = JSON.parse((await run([])).stdout)
  expect(first.comparison).toBeUndefined()

  const changed = await run(
    ['--baseline', first.directory, '--baseline', join(second.directory, 'result.json')],
    { EVAL_TEST_FAIL: '1', EVAL_TEST_LINE: 'the new line' },
  )
  expect(changed.code).toBe(1)
  const document = JSON.parse(changed.stdout)
  expect(document.baseline).toEqual(
    [first, second].map((item) => join(item.directory, 'result.json')),
  )
  expect(document.comparison.cases).toEqual([
    {
      name: 'greeting/text',
      baseline: { passed: 10, runs: 10 },
      current: { passed: 0, runs: 5 },
      p: expect.closeTo(1 / 3003, 8),
      change: 'regressed',
    },
    {
      name: 'lookup/text',
      baseline: { passed: 10, runs: 10 },
      current: { passed: 5, runs: 5 },
      p: 1,
      change: 'unchanged',
    },
  ])
  expect(document.comparison.toolResults).toEqual({
    appeared: [
      {
        tool: 'lookup',
        result: '{"line":"the new line"}',
        cases: ['lookup/text'],
        returned: 5,
        of: 5,
        never: 10,
        p: expect.closeTo(1 / 3003, 8),
      },
    ],
    vanished: [
      {
        tool: 'lookup',
        result: '{"line":"the old line"}',
        cases: ['lookup/text'],
        returned: 10,
        of: 10,
        never: 5,
        p: expect.closeTo(1 / 3003, 8),
      },
    ],
  })

  const report = await readFile(document.report, 'utf8')
  expect(report.indexOf('## Compared with baseline')).toBeLessThan(report.indexOf('## Metrics'))
  expect(report).toContain(
    `Baseline: ${[first, second].map((item) => basename(item.directory)).join(', ')}.`,
  )
  expect(report).toContain('| greeting/text | 10/10 (100.0%) | 0/5 (0.0%) | <0.001 |')
  expect(report).toContain(
    '| lookup | {"line":"the new line"} | 5/5 runs | 0/10 runs | <0.001 | lookup/text |',
  )
})

it('keeps what each model call was given, with every distinct instruction once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const result = await invoke(['run', '--output', root, '--case', 'lookup/text'], {
    EVAL_TEST_AGENT: '1',
  })
  const evidence = JSON.parse(await readFile(JSON.parse(result.stdout).results[0].evidence, 'utf8'))
  expect(evidence.instructions).toEqual([
    'Look the line up.',
    'Lines looked up so far: 0',
    'Lines looked up so far: 1',
  ])
  expect(evidence.modelInputs).toEqual([
    { invocationId: expect.any(String), agentName: 'looker', system: [0, 1] },
    { invocationId: expect.any(String), agentName: 'looker', system: [0, 2] },
  ])
  expect(
    evidence.events.filter((event: { type: string }) => event.type === 'model_start'),
  ).toHaveLength(evidence.modelInputs.length)
})

it('rejects a missing or unreadable baseline before running, and run options with list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const missing = await invoke(['run', '--output', root, '--baseline', join(root, 'none')])
  expect(missing.code).toBe(2)
  expect(JSON.parse(missing.stdout).directory).toBeUndefined()
  const empty = join(root, 'result.json')
  await writeFile(empty, JSON.stringify({ summary: {} }))
  const unread = await invoke(['run', '--output', root, '--baseline', empty])
  expect(unread.code).toBe(2)
  expect(JSON.parse(unread.stdout).error.message).toBe(`Baseline has no results: ${empty}`)
  expect(await readdir(root)).toEqual(['result.json'])
  const listed = await invoke(['list', '--baseline', root])
  expect(listed.code).toBe(2)
})
