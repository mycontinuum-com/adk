import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  CONCURRENCY,
  COUNTED,
  GREETING,
  LOOKER,
  LOOKUP,
  VOICE,
} from '../test-support/eval-cli-suite'
import {
  commitAll,
  git,
  head,
  TEST_FILE,
  TEST_ORIGIN,
  TEST_REPOSITORY,
  testRepository,
} from '../test-support/scorecard-repository'

const exec = promisify(execFile)
const fixture = resolve(import.meta.dirname, '../test-support/eval-cli.ts')
// A bare `tsx` resolves from the working directory, which a scorecard test moves out of the package.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

async function invoke(args: string[], env: Record<string, string> = {}, cwd?: string) {
  try {
    const result = await exec(process.execPath, ['--import', tsx, fixture, ...args], {
      env: { ...process.env, ...env },
      cwd,
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
    {
      modelStartId: expect.any(String),
      invocationId: expect.any(String),
      agentName: 'looker',
      system: [0, 1],
    },
    {
      modelStartId: expect.any(String),
      invocationId: expect.any(String),
      agentName: 'looker',
      system: [0, 2],
    },
  ])
  expect(
    evidence.events.filter((event: { type: string }) => event.type === 'model_start'),
  ).toHaveLength(evidence.modelInputs.length)
})

it.each([
  { name: 'lookup/text', mode: 'EVAL_TEST_INTERCEPT', skipped: 1, invocations: 1 },
  {
    name: 'lookup/repeated',
    mode: 'EVAL_TEST_MULTIPLE_INVOCATIONS',
    skipped: 0,
    invocations: 2,
  },
])(
  'binds model inputs to actual start events for $name',
  async ({ name, mode, skipped, invocations }) => {
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const result = await invoke(['run', '--output', root, '--case', name], {
      EVAL_TEST_AGENT: '1',
      [mode]: '1',
    })
    expect(result.code).toBe(0)
    const evidence = JSON.parse(
      await readFile(JSON.parse(result.stdout).results[0].evidence, 'utf8'),
    )
    const starts = evidence.events.filter((event: { type: string }) => event.type === 'model_start')
    expect(starts.length).toBe(evidence.modelInputs.length + skipped)
    expect(new Set(starts.map((event: { invocationId: string }) => event.invocationId)).size).toBe(
      invocations,
    )
    expect(
      evidence.modelInputs.map((input: { modelStartId: string }) => input.modelStartId),
    ).toEqual(starts.slice(skipped).map((event: { id: string }) => event.id))
    for (const input of evidence.modelInputs) {
      const start = starts.find((event: { id: string }) => event.id === input.modelStartId)
      expect(input.invocationId).toBe(start.invocationId)
      expect(input.agentName).toBe(start.agentName)
    }
  },
)

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

const MIXED = { EVAL_TEST_MIXED: '1' }
const AGENT = { EVAL_TEST_AGENT: '1' }
const FAILING = { EVAL_TEST_FAIL: '1' }
/** Where the suite keeps its scorecard, from the top of the outermost repository. */
const SCORECARD = 'scorecards/greeting.json'
const DECLARED = { ...AGENT, EVAL_TEST_SCORECARD: SCORECARD }
/** A scorecard that another runner wrote, without its results. */
const HEADER = {
  version: 2,
  recorded: '2026-10-09T14:03:22Z',
  repo: TEST_REPOSITORY,
  commit: '0123456789abcdef0123456789abcdef01234567',
  runner: 'evals-harness',
  models: [{ model: 'gpt-5-mini' }],
}
const MEASURES = { 'answer_key.f1': { value: 0.578, n: 256 } }
const RECORDED = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
const NOT_COMPARED = 'Not compared: no baseline kept its tool results.'

/** The name, kind and status of each result in the document a run printed. */
function outcomes(stdout: string) {
  return JSON.parse(stdout).results.map((item: { name: string; kind: string; status: string }) => [
    item.name,
    item.kind,
    item.status,
  ])
}

/** Runs the suite, and gives its exit code with the message of the error it printed. */
async function failure(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const result = await invoke(['run', ...args], env, cwd)
  return [result.code, JSON.parse(result.stdout).error.message]
}

/** Runs the suite with `--record` in `repository`. */
function record(
  root: string,
  repository: string,
  env: Record<string, string>,
  args: string[] = [],
) {
  return invoke(['run', '--record', '--output', root, ...args], env, repository)
}

/** Writes `scorecard` where the suite declares its own, and gives how a run in `repository` failed. */
async function rejectedDeclared(root: string, repository: string, file: string, scorecard: object) {
  await writeFile(file, JSON.stringify(scorecard))
  return failure(['--output', root], DECLARED, repository)
}

/** A committed repository for the suite with the directory of its scorecard, and that file. */
async function suiteRepository() {
  const repository = await testRepository()
  await mkdir(join(repository, dirname(SCORECARD)))
  return { repository, file: join(repository, SCORECARD) }
}

async function runner() {
  const manifest = await readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8')
  return `@animahealth/adk@${JSON.parse(manifest).version}`
}

it('runs only the cases of one kind, with --case narrowing them further', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const output = ['--output', root]
  const text = 'text'
  const voice = 'voice'

  const texts = await invoke(['run', ...output, '--kind', text], MIXED)
  expect(texts.code).toBe(0)
  expect(outcomes(texts.stdout)).toEqual([[GREETING, text, 'passed']])
  const voices = await invoke(['run', ...output, '--kind', voice], MIXED)
  expect(outcomes(voices.stdout)).toEqual([[VOICE, voice, 'error']])

  expect(await failure([...output, '--kind', voice, '--case', GREETING], MIXED)).toEqual([
    2,
    `No ${voice} case is selected`,
  ])
  const unknown = 'nope'
  expect(await failure([...output, '--kind', unknown], MIXED)).toEqual([
    2,
    `Unknown kind: ${unknown}. Expected ${text} or ${voice}.`,
  ])
})

describe('scorecard', () => {
  it('records exactly the run and the commit it ran on, a failing case included, and replaces the file whole on the next record', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const suite = [GREETING, LOOKUP]
    const repeat = 2
    const first = await record(root, repository, DECLARED, ['--repeat', String(repeat)])
    expect(first.code).toBe(0)
    const text = await readFile(file, 'utf8')
    const scorecard = JSON.parse(text)
    const commit = await head(repository)
    const writer = { repo: TEST_REPOSITORY, commit, runner: await runner() }
    const every = { passed: repeat, runs: repeat }
    expect(scorecard).toEqual({
      version: 2,
      recorded: RECORDED,
      ...writer,
      models: [LOOKER],
      judges: [],
      repeat,
      cases: { [GREETING]: every, [LOOKUP]: every },
    })
    const keys = ['version', 'recorded', 'repo', 'commit', 'runner', 'models', 'judges', 'repeat']
    expect(Object.keys(scorecard)).toEqual([...keys, 'cases'])
    expect(text).toBe(`${JSON.stringify(scorecard, null, 2)}\n`)
    const document = JSON.parse(first.stdout)
    expect(document.provenance).toEqual({
      commit,
      dirty: false,
      runner: writer.runner,
      models: [LOOKER],
      judges: [],
    })
    expect(document.record).toEqual({ file, written: true })
    expect(first.stderr).toContain(
      `Recorded ${file}. Cases: ${suite.length} now, no file before.\n`,
    )

    // The scorecard is in the checkout it measures here, so it is committed before the next record.
    await commitAll(repository)
    const second = await record(root, repository, { ...DECLARED, ...FAILING }, ['--case', GREETING])
    expect(second.code).toBe(1)
    expect(JSON.parse(second.stdout).record).toEqual({ file, written: true })
    const replaced = JSON.parse(await readFile(file, 'utf8'))
    expect(replaced).toEqual({
      version: 2,
      recorded: RECORDED,
      ...writer,
      commit: await head(repository),
      models: [],
      judges: [],
      repeat: 1,
      costUsd: 0,
      cases: { [GREETING]: { passed: 0, runs: 1 } },
    })
    expect(Object.keys(replaced)).toEqual([...keys, 'costUsd', 'cases'])
    expect(second.stderr).toContain(`Recorded ${file}. Cases: 1 now, ${suite.length} before.\n`)
  })

  it('records into the repository that holds the suite as a submodule, once the directory is there', async () => {
    const outer = await testRepository()
    await git(outer, 'remote', 'set-url', 'origin', 'https://github.com/example/outer.git')
    const inner = await testRepository()
    await git(outer, 'submodule', 'add', '-q', inner, 'sub')
    await commitAll(outer)
    const suite = join(outer, 'sub')
    // A clone names its source as its origin; the suite's repository is the one on GitHub.
    await git(suite, 'remote', 'set-url', 'origin', TEST_ORIGIN)
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const file = join(outer, SCORECARD)

    expect(await failure(['--record', '--output', root], DECLARED, suite)).toEqual([
      2,
      `--record needs the directory ${dirname(file)}, which does not exist. Record from the checkout that keeps the scorecards.`,
    ])
    const unread = await invoke(['run', '--output', root], DECLARED, suite)
    expect(unread.code).toBe(0)
    expect(unread.stderr).toContain(`No scorecard at ${file} yet: nothing to compare with.\n`)
    expect(JSON.parse(unread.stdout).baseline).toBeUndefined()

    await mkdir(dirname(file))
    expect((await record(root, suite, DECLARED)).code).toBe(0)
    const once = { passed: 1, runs: 1 }
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 2,
      recorded: RECORDED,
      repo: TEST_REPOSITORY,
      commit: await head(suite),
      runner: await runner(),
      models: [LOOKER],
      judges: [],
      repeat: 1,
      cases: { [GREETING]: once, [LOOKUP]: once },
    })
    const compared = await invoke(['run', '--output', root], DECLARED, suite)
    expect(JSON.parse(compared.stdout).baseline).toEqual([file])
  })

  it('refuses to record a checkout with any uncommitted change, whatever it is set to hide, before any case runs', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const counter = { EVAL_TEST_COUNTER: join(root, 'counter.txt') }
    const untracked = 'new.txt'
    await git(repository, 'config', 'status.showUntrackedFiles', 'no')
    await writeFile(join(repository, TEST_FILE), 'changed\n')
    await writeFile(join(repository, untracked), 'new\n')
    expect(
      await failure(['--record', '--output', root], { ...DECLARED, ...counter }, repository),
    ).toEqual([
      2,
      `--record needs a committed checkout, and git status reports M ${TEST_FILE}; ?? ${untracked}. Commit first, then record.`,
    ])
    expect(await readdir(root)).toEqual([])

    await commitAll(repository)
    expect((await record(root, repository, DECLARED)).code).toBe(0)
    expect(JSON.parse(await readFile(file, 'utf8')).commit).toBe(await head(repository))
  })

  it('does not record a run whose case changed the checkout while it ran', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    await record(root, repository, DECLARED)
    await commitAll(repository)
    const recorded = await readFile(file, 'utf8')

    const appending = { EVAL_TEST_COUNTER: join(repository, TEST_FILE) }
    const result = await record(root, repository, { ...DECLARED, ...appending })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `Not recorded ${file}: the checkout changed during the run, and git status reports M ${TEST_FILE}.\n`,
    )
    const document = JSON.parse(result.stdout)
    expect(document.record).toEqual({ file, written: false })
    expect(outcomes(result.stdout)).toEqual([
      [GREETING, 'text', 'passed'],
      [LOOKUP, 'text', 'passed'],
    ])
    expect(JSON.parse(await readFile(join(document.directory, 'result.json'), 'utf8'))).toEqual(
      document,
    )
    expect(await readFile(file, 'utf8')).toBe(recorded)
  })

  it('leaves the scorecard as it was, and says why, after a run that errored or stopped early', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const scorecard = { EVAL_TEST_SCORECARD: SCORECARD }
    await record(root, repository, DECLARED)
    await commitAll(repository)
    const recorded = await readFile(file, 'utf8')

    const unjudged = 'error'
    const errored = await record(root, repository, { ...scorecard, ...MIXED })
    expect(errored.code).toBe(1)
    expect(outcomes(errored.stdout)).toEqual([
      [GREETING, 'text', 'passed'],
      [VOICE, 'voice', unjudged],
    ])
    expect(errored.stderr).toContain(
      `Not recorded ${file}: 1 of 2 runs ended without a verdict (${unjudged}).\n`,
    )
    expect(JSON.parse(errored.stdout).record).toEqual({ file, written: false })
    expect(await readFile(file, 'utf8')).toBe(recorded)

    const repeat = 3
    const stopped = await record(
      root,
      repository,
      { ...scorecard, ...FAILING, EVAL_TEST_STOP: '1' },
      ['--repeat', String(repeat)],
    )
    expect(stopped.code).toBe(1)
    expect(stopped.stderr).toContain(
      `Not recorded ${file}: ${CONCURRENCY} of ${repeat} runs completed.\n`,
    )
    expect(JSON.parse(stopped.stdout).record).toEqual({ file, written: false })
    expect(await readFile(file, 'utf8')).toBe(recorded)
  })

  it('saves and prints the results of a run whose scorecard cannot be written, and says it was not written', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    await chmod(dirname(file), 0o555)
    try {
      const result = await record(root, repository, DECLARED)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`Not recorded ${file}: EACCES`)
      const document = JSON.parse(result.stdout)
      expect(document.record).toEqual({ file, written: false })
      expect(outcomes(result.stdout)).toEqual([
        [GREETING, 'text', 'passed'],
        [LOOKUP, 'text', 'passed'],
      ])
      expect(JSON.parse(await readFile(join(document.directory, 'result.json'), 'utf8'))).toEqual(
        document,
      )
    } finally {
      await chmod(dirname(file), 0o755)
    }
  })

  it('compares with the scorecard when no baseline is given, naming when and at which commit it was recorded', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const repeat = 5
    const run = ['run', '--repeat', String(repeat), '--output', root]
    await invoke([...run, '--record'], DECLARED, repository)
    const { recorded, commit } = JSON.parse(await readFile(file, 'utf8'))

    const failing = await invoke(run, { ...DECLARED, ...FAILING }, repository)
    expect(failing.code).toBe(1)
    const document = JSON.parse(failing.stdout)
    expect(document.record).toBeUndefined()
    expect(document.baseline).toEqual([file])
    const every = { passed: repeat, runs: repeat }
    expect(document.comparison.cases).toEqual([
      {
        name: GREETING,
        baseline: every,
        current: { passed: 0, runs: repeat },
        p: expect.closeTo(2 / 252, 8),
        change: 'regressed',
      },
      { name: LOOKUP, baseline: every, current: every, p: 1, change: 'unchanged' },
    ])
    const report = await readFile(document.report, 'utf8')
    expect(report).toContain(
      `Baseline: ${basename(file, '.json')} (recorded ${recorded} at ${commit.slice(0, 10)}).`,
    )
    expect(report).toContain(NOT_COMPARED)
  })

  it('refuses what the suite or the repository cannot support, before any case runs', async () => {
    const { repository } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const output = ['--output', root]
    const counter = { EVAL_TEST_COUNTER: join(root, 'counter.txt') }
    const declared = { ...counter, EVAL_TEST_SCORECARD: SCORECARD }

    expect(await failure([...output, '--record'], counter)).toEqual([
      2,
      '--record needs a scorecard: set `scorecard` in the options of evaluate.cli',
    ])
    expect(await failure(output, declared, root)).toEqual([
      2,
      expect.stringMatching(/^A scorecard needs a git repository: not a git repository/),
    ])
    const empty = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    expect(await failure(output, { ...declared, PATH: empty }, repository)).toEqual([
      2,
      'A scorecard needs a git repository: spawn git ENOENT',
    ])
    await git(repository, 'remote', 'remove', 'origin')
    expect(await failure([...output, '--record'], declared, repository)).toEqual([
      2,
      "--record names the repository from its origin remote: No such remote 'origin'",
    ])
    const uncommitted = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    await git(uncommitted, 'init', '-q')
    await mkdir(join(uncommitted, dirname(SCORECARD)))
    expect(await failure([...output, '--record'], declared, uncommitted)).toEqual([
      2,
      '--record needs a commit to record against',
    ])
    expect(await readdir(root)).toEqual([])

    const plain = await invoke(['run', ...output], declared, repository)
    expect(plain.code).toBe(0)
    expect(await readFile(counter.EVAL_TEST_COUNTER, 'utf8')).toBe(COUNTED)
    const undeclared = await invoke(['run', ...output], counter, root)
    expect(JSON.parse(undeclared.stdout).provenance).toEqual({
      runner: await runner(),
      models: [],
      judges: [],
    })
  })

  it('reads the checkout around a broken submodule, which it leaves out as its own checkout', async () => {
    const repository = await testRepository()
    const submodule = join(repository, 'sub')
    await mkdir(submodule)
    await git(submodule, 'init', '-q')
    await git(submodule, 'commit', '-q', '--allow-empty', '-m', 'inner')
    await commitAll(repository)
    await rm(join(submodule, '.git'), { recursive: true })
    await writeFile(join(submodule, '.git'), 'gitdir: gone\n')
    await expect(git(repository, 'status', '--porcelain')).rejects.toThrow(
      /not a git repository|does not point to a valid repository/,
    )

    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const result = await invoke(['run', '--output', root], {}, repository)
    expect(result.code).toBe(0)
    const document = JSON.parse(result.stdout)
    expect(outcomes(result.stdout)).toEqual([[GREETING, 'text', 'passed']])
    expect(document.provenance).toEqual({
      commit: await head(repository),
      dirty: false,
      runner: await runner(),
      models: [],
      judges: [],
    })
  })

  it('rejects a declared scorecard of another version, with no commit or with no cases, and any scorecard as a baseline', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const versioned = { ...HEADER, version: 1, cases: {} }
    expect(await rejectedDeclared(root, repository, file, versioned)).toEqual([
      2,
      expect.stringContaining(`Invalid scorecard ${file}: version: `),
    ])
    const uncommitted = { ...HEADER, commit: undefined, cases: {} }
    expect(await rejectedDeclared(root, repository, file, uncommitted)).toEqual([
      2,
      expect.stringContaining(`Invalid scorecard ${file}: commit: `),
    ])
    const measured = { ...HEADER, measures: MEASURES }
    expect(await rejectedDeclared(root, repository, file, measured)).toEqual([
      2,
      `Invalid scorecard ${file}: cases: this CLI compares cases, and the file has none`,
    ])
    expect(await failure(['--output', root, '--baseline', file])).toEqual([
      2,
      `Baseline has no results: ${file}`,
    ])
    expect(await readdir(root)).toEqual([])
  })

  it('names the scorecard or the baseline evidence that is not JSON, as conflict markers are not', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const output = ['--output', root]
    const conflicted = '<<<<<<< HEAD\n{}\n'
    const reason = 'Unexpected token'
    await writeFile(file, conflicted)
    expect(await failure(output, DECLARED, repository)).toEqual([
      2,
      expect.stringContaining(`Invalid scorecard ${file}: ${reason}`),
    ])

    const evidence = join(root, 'case-1.json')
    await writeFile(evidence, conflicted)
    const saved = join(root, 'result.json')
    await writeFile(
      saved,
      JSON.stringify({ results: [{ name: GREETING, status: 'passed', evidence }] }),
    )
    expect(await failure([...output, '--baseline', saved])).toEqual([
      2,
      expect.stringContaining(`Invalid baseline ${evidence}: ${reason}`),
    ])
    expect(await readdir(root)).toEqual([basename(evidence), basename(saved)])
  })

  it('reads a declared scorecard that names no agent for a model and has judges and measures beside its cases', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const every = { passed: 3, runs: 3 }
    const recorded = {
      ...HEADER,
      judges: [{ model: 'gpt-6-astra' }],
      cases: { [GREETING]: every },
      measures: MEASURES,
    }
    await writeFile(file, JSON.stringify(recorded))
    const result = await invoke(['run', '--case', GREETING, '--output', root], DECLARED, repository)
    expect(result.code).toBe(0)
    const verdict = { baseline: every, current: { passed: 1, runs: 1 }, p: 1, change: 'unchanged' }
    expect(JSON.parse(result.stdout).comparison).toEqual({
      alpha: 0.05,
      overall: verdict,
      cases: [{ name: GREETING, ...verdict }],
      added: [],
      removed: [],
    })
  })
})
