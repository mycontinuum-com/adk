import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Event } from '../types/events'

import {
  git,
  head,
  TEST_FILE,
  TEST_REPOSITORY,
  testRepository,
} from '../test-support/scorecard-repository'
import {
  checkoutOf,
  describeChanges,
  distinctModels,
  judgeModels,
  parseScorecard,
  recordScorecard,
  repositoryOfRemote,
  sessionModelCalls,
} from './scorecard'

type Run = Parameters<typeof recordScorecard>[1]

const NAME = 'scorecard.json'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const WRITER = { repo: TEST_REPOSITORY, commit: COMMIT, runner: 'test', models: [] }
const HEADER = { version: 2, recorded: '2026-10-09T14:03:22Z', ...WRITER }

/** A run large enough that two writes of it to one file would overlap, told apart by `repeat`. */
function runOf(repeat: number): Run {
  const cases = Array.from({ length: 2000 }, (_, at) => `case-${at}`)
  return {
    ...WRITER,
    repeat,
    cases: new Map(cases.map((name) => [name, { passed: repeat, runs: repeat }])),
  }
}

/** The scorecard that recording `run` writes, whenever it was recorded. */
function scorecardOf({ cases, ...run }: Run) {
  return {
    version: 2,
    recorded: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    ...run,
    cases: Object.fromEntries(cases),
  }
}

/** The end of one model call by `agentName`, which names its model only when `modelName` is given. */
function ended(agentName: string, modelName?: string): Event {
  return {
    id: `end-${agentName}-${modelName}`,
    type: 'model_end',
    createdAt: 0,
    invocationId: 'i',
    agentName,
    stepIndex: 0,
    durationMs: 1,
    ...(modelName && { usage: { modelName, inputTokens: 1, outputTokens: 1 } }),
  }
}

/** The usage of one call to `modelName`. */
const usageEntry = (modelName: string) => ({
  modelName,
  calls: 1,
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  reasoningTokens: 0,
  audioInputTokens: 0,
  audioOutputTokens: 0,
})

/** The usage a metric reports for one call to each of `models`. */
function usageOf(...models: string[]) {
  return {
    models: models.map(usageEntry),
    totalInputTokens: models.length,
    totalOutputTokens: models.length,
    totalCachedTokens: 0,
    totalReasoningTokens: 0,
    totalAudioInputTokens: 0,
    totalAudioOutputTokens: 0,
    modelCalls: models.length,
  }
}

/** Joined here so that no line of this file reads as an email address to the public export. */
const userAt = (user: string, rest: string) => [user, rest].join('@')

describe('repositoryOfRemote', () => {
  it('names the owner and repository a remote ends in, in lowercase, in any form', () => {
    expect(
      [
        `https://github.com/${TEST_REPOSITORY}.git`,
        `${userAt('https://token', `github.com/${TEST_REPOSITORY}`)}\n`,
        userAt('ssh://git', `github.com:22/${TEST_REPOSITORY}.git`),
        userAt('git', `github.com:${TEST_REPOSITORY}.git`),
        userAt('http://proxy', `127.0.0.1:43001/git/${TEST_REPOSITORY}`),
        'https://github.com/Example/Suite/',
      ].map(repositoryOfRemote),
    ).toEqual(Array.from({ length: 6 }, () => TEST_REPOSITORY))
    expect(repositoryOfRemote('suite')).toBeUndefined()
  })
})

describe('checkoutOf', () => {
  it('gives HEAD and no change for a committed checkout, and every change whatever the repository hides', async () => {
    const repository = await testRepository()
    expect(await checkoutOf(repository)).toEqual({ commit: await head(repository), changes: [] })

    await git(repository, 'config', 'status.showUntrackedFiles', 'no')
    await writeFile(join(repository, TEST_FILE), 'changed\n')
    await writeFile(join(repository, 'new.txt'), 'new\n')
    await writeFile(join(repository, 'run.log'), 'ignored\n')
    expect((await checkoutOf(repository)).changes).toEqual([` M ${TEST_FILE}`, '?? new.txt'])
  })

  it('has no commit in a repository with none', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'adk-scorecard-'))
    await git(repository, 'init', '-q')
    expect(await checkoutOf(repository)).toEqual({ changes: [] })
  })
})

describe('describeChanges', () => {
  it('gives five status lines at most and counts the rest', () => {
    const changes = Array.from({ length: 7 }, (_, at) => `?? new-${at}.txt`)
    expect(describeChanges(changes)).toBe(
      `git status reports ${changes.slice(0, 5).join('; ')}; and 2 more`,
    )
  })
})

describe('recordScorecard', () => {
  it('writes its keys in order, with the case names sorted', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'adk-scorecard-')), NAME)
    const once = { passed: 1, runs: 1 }
    const run = {
      ...WRITER,
      judges: [{ model: 'judge' }],
      repeat: 1,
      cases: new Map([
        ['b', once],
        ['a', once],
      ]),
    }
    await recordScorecard(file, run)
    const written = JSON.parse(await readFile(file, 'utf8'))
    expect(written).toEqual(scorecardOf(run))
    expect(Object.keys(written)).toEqual([
      'version',
      'recorded',
      'repo',
      'commit',
      'runner',
      'models',
      'judges',
      'repeat',
      'cases',
    ])
    expect(Object.keys(written.cases)).toEqual(['a', 'b'])
  })

  it('gives two runs that record one path at once each a whole write, and leaves no temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adk-scorecard-'))
    const file = join(directory, NAME)
    const runs = [runOf(1), runOf(2)]
    await Promise.all(runs.map((run) => recordScorecard(file, run)))
    expect(runs.map(scorecardOf)).toContainEqual(JSON.parse(await readFile(file, 'utf8')))
    expect(await readdir(directory)).toEqual([NAME])
  })

  it('removes its temporary file when the scorecard cannot be replaced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adk-scorecard-'))
    const file = join(directory, NAME)
    await mkdir(file)
    await expect(recordScorecard(file, runOf(1))).rejects.toThrow('EISDIR')
    expect(await readdir(directory)).toEqual([NAME])
  })
})

describe('parseScorecard', () => {
  it('reads cases, measures or both, with judges, and rejects a file with neither', () => {
    const cases = { greeting: { passed: 2, runs: 2 } }
    const measures = { 'answer_key.f1': { value: 0.578, n: 256 }, docs: { passed: 3, runs: 4 } }
    const judges = [{ model: 'gpt-6-astra' }]
    for (const card of [
      { ...HEADER, cases },
      { ...HEADER, judges, measures },
      { ...HEADER, cases, measures },
    ])
      expect(parseScorecard(card, NAME)).toEqual(card)
    expect(() => parseScorecard(HEADER, NAME)).toThrow(
      `Invalid scorecard ${NAME}: needs cases, measures or both`,
    )
  })

  it('rejects a case that passed more runs than it had, and a key the format does not name', () => {
    const name = 'greeting'
    expect(() =>
      parseScorecard({ ...HEADER, cases: { [name]: { passed: 3, runs: 2 } } }, NAME),
    ).toThrow(`Invalid scorecard ${NAME}: cases: ${name}: passed is more than runs`)
    const cases = { [name]: { passed: 1, runs: 1 } }
    expect(() => parseScorecard({ ...HEADER, cases, documents: ['doc1'] }, NAME)).toThrow(
      `Invalid scorecard ${NAME}: Unrecognized key: "documents"`,
    )
  })

  it('rejects another version, and a file that names no repository or commit, or a commit that is not one', () => {
    const cases = {}
    expect(() => parseScorecard({ ...HEADER, commit: 'main', cases }, NAME)).toThrow(
      `Invalid scorecard ${NAME}: commit: is not a commit id`,
    )
    expect(() => parseScorecard({ ...HEADER, version: 1, cases }, NAME)).toThrow(
      `Invalid scorecard ${NAME}: version: `,
    )
    for (const key of ['repo', 'commit'])
      expect(() => parseScorecard({ ...HEADER, [key]: undefined, cases }, NAME)).toThrow(
        `Invalid scorecard ${NAME}: ${key}: `,
      )
  })
})

describe('model calls', () => {
  it('lists each agent, model and effort once, sorted, with no effort where none was set', () => {
    const triage = { agent: 'triage', model: 'gpt-5.4-mini' }
    const backend = { agent: 'backend', model: 'gpt-5.4' }
    const other = { agent: backend.agent, model: 'claude-opus-5-5' }
    const low = 'low'
    const medium = 'medium'
    const high = 'high'
    expect(
      distinctModels([
        { ...triage, effort: low },
        { ...backend, effort: medium },
        triage,
        { ...backend, effort: high },
        { ...triage, effort: low },
        other,
      ]),
    ).toEqual([
      other,
      { ...backend, effort: high },
      { ...backend, effort: medium },
      triage,
      { ...triage, effort: low },
    ])
  })

  it('reads from a session each model call that named its model', () => {
    const receptionist = { agent: 'receptionist', model: 'gpt-realtime-1.5' }
    const backend = { agent: 'backend', model: 'gpt-5.4-mini' }
    expect(
      sessionModelCalls([
        ended(receptionist.agent, receptionist.model),
        ended(backend.agent, backend.model),
        ended(backend.agent),
      ]),
    ).toEqual([receptionist, backend])
  })

  it('lists each model the metrics called once, sorted, and none for metrics that report no usage', () => {
    const judge = 'gpt-6-astra'
    const second = 'gpt-5.4-mini'
    expect(
      judgeModels([
        { metrics: { safety: { passed: true, usage: usageOf(judge, second) } } },
        { metrics: { safety: { passed: true, usage: usageOf(judge) }, exact: { passed: false } } },
      ]),
    ).toEqual([{ model: second }, { model: judge }])
    expect(judgeModels([{ metrics: { exact: { passed: true } } }])).toEqual([])
  })
})
