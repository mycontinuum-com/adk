import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Event } from '../types/events'

import {
  commitAll,
  git,
  VECTOR_EDIT,
  VECTOR_IDS,
  VECTOR_OUTSIDE,
  VECTOR_PATHS,
  vectorRepository,
} from '../test-support/scorecard-repository'
import {
  changeSince,
  distinctModels,
  fingerprintOf,
  parseScorecard,
  recordScorecard,
  sessionModelCalls,
} from './scorecard'

type Run = Parameters<typeof recordScorecard>[1]

const NAME = 'scorecard.json'
const WRITER = { fingerprint: VECTOR_IDS, runner: 'test', models: [] }
const HEADER = { version: 1, recorded: '2026-10-09T14:03:22Z', ...WRITER }
/** Two names that UTF-8 bytes put in this order, and JavaScript's string order in the other. */
const FULLWIDTH = '～'
const EMOJI = '\u{1F600}'

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
    version: 1,
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

describe('fingerprintOf', () => {
  it('gives the ids of the shared test values, and a new id for a directory only once an edit under it is committed', async () => {
    const repository = await vectorRepository()
    expect(await fingerprintOf(repository, VECTOR_PATHS)).toEqual(VECTOR_IDS)

    await writeFile(join(repository, VECTOR_EDIT.file), VECTOR_EDIT.content)
    expect(await fingerprintOf(repository, VECTOR_PATHS)).toEqual(VECTOR_IDS)
    await commitAll(repository)
    expect(await fingerprintOf(repository, VECTOR_PATHS)).toEqual(VECTOR_EDIT.ids)

    await writeFile(join(repository, VECTOR_OUTSIDE), 'outside changed\n')
    await commitAll(repository)
    expect(await fingerprintOf(repository, VECTOR_PATHS)).toEqual(VECTOR_EDIT.ids)
  })

  it('lists its paths in UTF-8 byte order where that differs from the order JavaScript sorts strings in', async () => {
    const repository = await vectorRepository()
    await Promise.all([FULLWIDTH, EMOJI].map((name) => writeFile(join(repository, name), name)))
    await commitAll(repository)
    expect(Object.keys(await fingerprintOf(repository, [EMOJI, FULLWIDTH]))).toEqual([
      FULLWIDTH,
      EMOJI,
    ])
  })

  it('names a path that is not in HEAD, whether it is missing or was never committed', async () => {
    const repository = await vectorRepository()
    const missing = 'evlas'
    await expect(fingerprintOf(repository, [...VECTOR_PATHS, missing])).rejects.toThrow(
      `Scorecard fingerprint: path '${missing}' does not exist in 'HEAD'`,
    )
    const uncommitted = 'new.txt'
    await writeFile(join(repository, uncommitted), 'new\n')
    await expect(fingerprintOf(repository, [uncommitted])).rejects.toThrow(
      `Scorecard fingerprint: path '${uncommitted}' exists on disk, but not in 'HEAD'`,
    )
  })
})

describe('changeSince', () => {
  it('says nothing while the paths are as they were, and names the path that has another id once an edit is committed', async () => {
    const repository = await vectorRepository()
    expect(await changeSince(VECTOR_IDS, repository)).toBeUndefined()
    await writeFile(join(repository, VECTOR_OUTSIDE), 'outside changed\n')
    await commitAll(repository)
    expect(await changeSince(VECTOR_IDS, repository)).toBeUndefined()

    await writeFile(join(repository, VECTOR_EDIT.file), VECTOR_EDIT.content)
    await commitAll(repository)
    expect(await changeSince(VECTOR_IDS, repository)).toBe(
      `HEAD has another id for ${dirname(VECTOR_EDIT.file)}`,
    )
  })

  it('takes a path as a name, so an edit that the name would match as a pattern is not its change', async () => {
    const repository = await vectorRepository()
    const starred = 'd*'
    await mkdir(join(repository, starred))
    await writeFile(join(repository, starred, 'c.txt'), 'gamma\n')
    await commitAll(repository)
    const fingerprint = await fingerprintOf(repository, [starred])
    await writeFile(join(repository, VECTOR_EDIT.file), VECTOR_EDIT.content)
    expect(await changeSince(fingerprint, repository)).toBeUndefined()
  })

  it('gives the status line of each uncommitted change, five at most, whatever the settings of the repository hide', async () => {
    const repository = await vectorRepository()
    await git(repository, 'config', 'status.showUntrackedFiles', 'no')
    await writeFile(join(repository, VECTOR_EDIT.file), VECTOR_EDIT.content)
    const untracked = Array.from({ length: 6 }, (_, at) =>
      join(dirname(VECTOR_EDIT.file), `new-${at}.txt`),
    )
    await Promise.all(untracked.map((file) => writeFile(join(repository, file), 'new\n')))
    const shown = [`M ${VECTOR_EDIT.file}`, ...untracked.slice(0, 4).map((file) => `?? ${file}`)]
    expect(await changeSince(VECTOR_IDS, repository)).toBe(
      `git status reports ${shown.join('; ')}; and 2 more`,
    )
  })
})

describe('recordScorecard', () => {
  it('writes case names in UTF-8 byte order where that differs from the order JavaScript sorts strings in', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'adk-scorecard-')), NAME)
    const once = { passed: 1, runs: 1 }
    const run = {
      ...WRITER,
      repeat: 1,
      cases: new Map([
        [EMOJI, once],
        [FULLWIDTH, once],
      ]),
    }
    await recordScorecard(file, run)
    const written = JSON.parse(await readFile(file, 'utf8'))
    expect(written).toEqual(scorecardOf(run))
    expect(Object.keys(written.cases)).toEqual([FULLWIDTH, EMOJI])
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
  it('reads a case that passed every run, and rejects one that passed more runs than it had', () => {
    const name = 'greeting'
    const every = { ...HEADER, cases: { [name]: { passed: 2, runs: 2 } } }
    expect(parseScorecard(every, NAME)).toEqual(every)
    expect(() =>
      parseScorecard({ ...HEADER, cases: { [name]: { passed: 3, runs: 2 } } }, NAME),
    ).toThrow(`Invalid scorecard ${NAME}: cases: ${name}: passed is more than runs`)
  })

  it('reads the cases of a scorecard that also has measures, and rejects one that has measures only', () => {
    const cases = { greeting: { passed: 2, runs: 2 } }
    const measures = { 'answer_key.f1': { value: 0.578, n: 256 } }
    expect(parseScorecard({ ...HEADER, cases, measures }, NAME)).toEqual({ ...HEADER, cases })
    expect(() => parseScorecard({ ...HEADER, measures }, NAME)).toThrow(
      `Invalid scorecard ${NAME}: cases: this CLI compares cases, and the file has none`,
    )
  })

  it('rejects a fingerprint that lists no path', () => {
    expect(() => parseScorecard({ ...HEADER, fingerprint: {}, cases: {} }, NAME)).toThrow(
      `Invalid scorecard ${NAME}: fingerprint: lists no path`,
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
})
