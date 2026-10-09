import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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
  VECTOR_EDIT,
  VECTOR_IDS,
  VECTOR_OUTSIDE,
  VECTOR_PATHS,
  vectorRepository,
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

const MIXED = { EVAL_TEST_MIXED: '1' }
const AGENT = { EVAL_TEST_AGENT: '1' }
const FAILING = { EVAL_TEST_FAIL: '1' }
/** Where the suite keeps its scorecard: outside the paths it fingerprints. */
const SCORECARD = 'scorecard.json'
const DECLARED = { ...AGENT, EVAL_TEST_SCORECARD: SCORECARD }
/** A scorecard that another runner wrote, without its fingerprint and its results. */
const HEADER = {
  version: 1,
  recorded: '2026-10-09T14:03:22Z',
  runner: 'evals-harness',
  models: [{ model: 'gpt-5-mini' }],
}
const MEASURES = { 'answer_key.f1': { value: 0.578, n: 256 } }
const RECORDED = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
const NOT_COMPARED = 'Not compared: no baseline kept its tool results.'
const ON_THESE_FILES = 'on these files'
const ON_DIFFERENT_FILES = 'on different files'

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

/** The provenance and the report of a run of the declared suite in `repository`, with no `--record`. */
async function plainRun(root: string, repository: string) {
  const result = await invoke(['run', '--output', root], DECLARED, repository)
  const { provenance, report } = JSON.parse(result.stdout)
  return { provenance, report: await readFile(report, 'utf8') }
}

/** Writes `scorecard` where the suite declares its own, and gives how a run in `repository` failed. */
async function rejectedDeclared(root: string, repository: string, file: string, scorecard: object) {
  await writeFile(file, JSON.stringify(scorecard))
  return failure(['--output', root], DECLARED, repository)
}

/** A committed repository for the suite, and the file its scorecard goes to. */
async function suiteRepository() {
  const repository = await vectorRepository()
  return { repository, file: join(repository, SCORECARD) }
}

async function head(repository: string) {
  return (await git(repository, 'rev-parse', 'HEAD')).stdout.trim()
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
  it('records exactly the run, a failing case included, and replaces the file whole on the next record', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const suite = [GREETING, LOOKUP]
    const repeat = 2
    const first = await record(root, repository, DECLARED, ['--repeat', String(repeat)])
    expect(first.code).toBe(0)
    const text = await readFile(file, 'utf8')
    const scorecard = JSON.parse(text)
    const writer = { fingerprint: VECTOR_IDS, runner: await runner() }
    const every = { passed: repeat, runs: repeat }
    expect(scorecard).toEqual({
      version: 1,
      recorded: RECORDED,
      ...writer,
      models: [LOOKER],
      repeat,
      cases: { [GREETING]: every, [LOOKUP]: every },
    })
    const keys = ['version', 'recorded', 'fingerprint', 'runner', 'models', 'repeat', 'cases']
    expect(Object.keys(scorecard)).toEqual(keys)
    expect(text).toBe(`${JSON.stringify(scorecard, null, 2)}\n`)
    const document = JSON.parse(first.stdout)
    expect(document.provenance).toEqual({
      ...writer,
      commit: await head(repository),
      dirty: false,
      models: [LOOKER],
    })
    expect(document.record).toEqual({ file, written: true })
    expect(first.stderr).toContain(
      `Recorded ${file}. Cases: ${suite.length} now, no file before.\n`,
    )

    const second = await record(root, repository, { ...DECLARED, ...FAILING }, ['--case', GREETING])
    expect(second.code).toBe(1)
    expect(JSON.parse(second.stdout).record).toEqual({ file, written: true })
    const replaced = JSON.parse(await readFile(file, 'utf8'))
    expect(replaced).toEqual({
      version: 1,
      recorded: RECORDED,
      ...writer,
      models: [],
      repeat: 1,
      costUsd: 0,
      cases: { [GREETING]: { passed: 0, runs: 1 } },
    })
    expect(Object.keys(replaced)).toEqual(keys.toSpliced(-1, 0, 'costUsd'))
    expect(second.stderr).toContain(`Recorded ${file}. Cases: 1 now, ${suite.length} before.\n`)
  })

  it('refuses to record while git reports a change under a fingerprint path, whatever it is set to hide, before any case runs', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const counter = { EVAL_TEST_COUNTER: join(root, 'counter.txt') }
    const untracked = join(dirname(VECTOR_EDIT.file), 'new.txt')
    await git(repository, 'config', 'status.showUntrackedFiles', 'no')
    await writeFile(join(repository, VECTOR_EDIT.file), VECTOR_EDIT.content)
    await writeFile(join(repository, untracked), 'new\n')
    expect(
      await failure(['--record', '--output', root], { ...DECLARED, ...counter }, repository),
    ).toEqual([
      2,
      `--record needs its fingerprint paths committed, and git status reports M ${VECTOR_EDIT.file}; ?? ${untracked}. Commit first, then record.`,
    ])
    expect(await readdir(root)).toEqual([])

    await rm(join(repository, untracked))
    await commitAll(repository)
    const committed = await record(root, repository, DECLARED)
    expect(committed.code).toBe(0)
    expect(JSON.parse(await readFile(file, 'utf8')).fingerprint).toEqual(VECTOR_EDIT.ids)
  })

  it('does not record a run whose case changed a fingerprinted file while it ran', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    await record(root, repository, DECLARED)
    const recorded = await readFile(file, 'utf8')

    const appending = { EVAL_TEST_COUNTER: join(repository, VECTOR_EDIT.file) }
    const result = await record(root, repository, { ...DECLARED, ...appending })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      `Not recorded ${file}: the fingerprint paths changed during the run, and git status reports M ${VECTOR_EDIT.file}.\n`,
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
    const { repository } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const blocker = join(repository, 'blocked')
    const blocked = join(basename(blocker), SCORECARD)
    const file = join(repository, blocked)
    const result = await record(root, repository, {
      ...AGENT,
      EVAL_TEST_SCORECARD: blocked,
      EVAL_TEST_COUNTER: blocker,
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`Not recorded ${file}: EEXIST`)
    const document = JSON.parse(result.stdout)
    expect(document.record).toEqual({ file, written: false })
    expect(outcomes(result.stdout)).toEqual([
      [GREETING, 'text', 'passed'],
      [LOOKUP, 'text', 'passed'],
    ])
    expect(JSON.parse(await readFile(join(document.directory, 'result.json'), 'utf8'))).toEqual(
      document,
    )
    expect(await readFile(blocker, 'utf8')).toBe(COUNTED)
  })

  it('compares with the scorecard when no baseline is given', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const repeat = 5
    const run = ['run', '--repeat', String(repeat), '--output', root]
    await invoke([...run, '--record'], DECLARED, repository)
    const { recorded } = JSON.parse(await readFile(file, 'utf8'))

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
    expect(report).toContain(`Baseline: ${SCORECARD} (recorded ${recorded} ${ON_THESE_FILES}).`)
    expect(report).toContain(NOT_COMPARED)
  })

  it('says a run is on different files once a path has an uncommitted edit, and still after the edit is committed', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    await record(root, repository, DECLARED)
    const { recorded } = JSON.parse(await readFile(file, 'utf8'))
    const baseline = `Baseline: ${SCORECARD} (recorded ${recorded} ${ON_DIFFERENT_FILES}).`
    const ran = { runner: await runner(), models: [LOOKER] }

    await writeFile(join(repository, VECTOR_EDIT.file), VECTOR_EDIT.content)
    const edited = await plainRun(root, repository)
    expect(edited.report).toContain(baseline)
    expect(edited.provenance).toEqual({
      fingerprint: VECTOR_IDS,
      commit: await head(repository),
      dirty: true,
      ...ran,
    })

    await commitAll(repository)
    const committed = await plainRun(root, repository)
    expect(committed.report).toContain(baseline)
    expect(committed.provenance).toEqual({
      fingerprint: VECTOR_EDIT.ids,
      commit: await head(repository),
      dirty: false,
      ...ran,
    })
  })

  it('says a run is on these files after a commit that touches nothing under the paths', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    await record(root, repository, DECLARED)
    const { recorded } = JSON.parse(await readFile(file, 'utf8'))
    const before = await head(repository)

    await writeFile(join(repository, VECTOR_OUTSIDE), 'outside changed\n')
    await commitAll(repository)
    const after = await head(repository)
    expect(after).not.toBe(before)
    const later = await plainRun(root, repository)
    expect(later.report).toContain(
      `Baseline: ${SCORECARD} (recorded ${recorded} ${ON_THESE_FILES}).`,
    )
    expect(later.provenance).toEqual({
      fingerprint: VECTOR_IDS,
      commit: after,
      dirty: false,
      runner: await runner(),
      models: [LOOKER],
    })
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
    const missing = 'evlas'
    const paths = [...VECTOR_PATHS, missing].join(',')
    expect(
      await failure(output, { ...declared, EVAL_TEST_FINGERPRINT: paths }, repository),
    ).toEqual([2, `Scorecard fingerprint: path '${missing}' does not exist in 'HEAD'`])
    const holder = dirname(VECTOR_EDIT.file)
    const inside = join(holder, SCORECARD)
    expect(await failure(output, { ...counter, EVAL_TEST_SCORECARD: inside }, repository)).toEqual([
      2,
      `The scorecard ${inside} is inside ${holder}, a path it fingerprints. Keep it outside its fingerprint paths.`,
    ])
    const outside = join(root, SCORECARD)
    expect(await failure(output, { ...counter, EVAL_TEST_SCORECARD: outside }, repository)).toEqual(
      [
        2,
        `The scorecard ${outside} is not in ${repository}, the repository that holds its fingerprint paths. Keep it in the repository of its paths.`,
      ],
    )
    const linked = join('linked', SCORECARD)
    await symlink(holder, join(repository, dirname(linked)))
    expect(await failure(output, { ...counter, EVAL_TEST_SCORECARD: linked }, repository)).toEqual([
      2,
      `The scorecard ${inside} is inside ${holder}, a path it fingerprints. Keep it outside its fingerprint paths.`,
    ])
    const nested = join(repository, 'nested')
    await git(repository, 'init', '--quiet', nested)
    const submodule = join(nested, 'evals', SCORECARD)
    expect(
      await failure(output, { ...counter, EVAL_TEST_SCORECARD: submodule }, repository),
    ).toEqual([
      2,
      `The scorecard ${submodule} is not in ${repository}, the repository that holds its fingerprint paths (git places it in ${nested}). Keep it in the repository of its paths.`,
    ])
    const unreadable = join(VECTOR_OUTSIDE, SCORECARD)
    expect(
      await failure(output, { ...counter, EVAL_TEST_SCORECARD: unreadable }, repository),
    ).toEqual([2, `ENOTDIR: not a directory, open '${join(repository, unreadable)}'`])
    expect(await failure(output, declared, root)).toEqual([
      2,
      expect.stringMatching(/^A scorecard needs a git repository: not a git repository/),
    ])
    const empty = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    expect(await failure(output, { ...declared, PATH: empty }, repository)).toEqual([
      2,
      'A scorecard needs a git repository: spawn git ENOENT',
    ])
    expect(await readdir(root)).toEqual([])

    const undeclared = await invoke(['run', ...output], counter, root)
    expect(await readFile(counter.EVAL_TEST_COUNTER, 'utf8')).toBe(COUNTED)
    expect(JSON.parse(undeclared.stdout).provenance).toEqual({
      runner: await runner(),
      models: [],
    })
  })

  it('runs a suite that declares no scorecard where git status fails, without commit or dirty', async () => {
    const repository = await vectorRepository()
    const submodule = join(repository, 'sub')
    await mkdir(submodule)
    await git(submodule, 'init', '-q')
    await git(submodule, 'commit', '-q', '--allow-empty', '-m', 'inner')
    await commitAll(repository)
    await rm(join(submodule, '.git'), { recursive: true })
    await writeFile(join(submodule, '.git'), 'gitdir: gone\n')
    await expect(git(repository, 'status', '--porcelain')).rejects.toThrow('not a git repository')

    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const result = await invoke(['run', '--output', root], {}, repository)
    expect(result.code).toBe(0)
    const document = JSON.parse(result.stdout)
    expect(outcomes(result.stdout)).toEqual([[GREETING, 'text', 'passed']])
    expect(document.provenance).toEqual({ runner: await runner(), models: [] })
  })

  it('rejects a declared scorecard of another version, with no fingerprint or with no cases, and any scorecard as a baseline', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const versioned = { ...HEADER, version: 2, cases: {} }
    expect(await rejectedDeclared(root, repository, file, versioned)).toEqual([
      2,
      expect.stringContaining(`Invalid scorecard ${file}: version: `),
    ])
    expect(await rejectedDeclared(root, repository, file, { ...HEADER, cases: {} })).toEqual([
      2,
      expect.stringContaining(`Invalid scorecard ${file}: fingerprint: `),
    ])
    const measured = { ...HEADER, fingerprint: VECTOR_IDS, measures: MEASURES }
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

  it('reads a declared scorecard that names no agent for a model and has measures beside its cases', async () => {
    const { repository, file } = await suiteRepository()
    const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
    const every = { passed: 3, runs: 3 }
    const recorded = {
      ...HEADER,
      fingerprint: VECTOR_IDS,
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
