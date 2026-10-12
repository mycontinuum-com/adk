import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import type { Event } from '../types/events'
import type { PassCount } from './compare'
import type { BaseEvalCaseResult } from './types'

const count = z.number().int().nonnegative()

const passCount = z
  .strictObject({ passed: count, runs: count })
  .refine((tally) => tally.passed <= tally.runs, { message: 'passed is more than runs' })

const modelEntry = z.strictObject({
  agent: z.string().optional(),
  model: z.string(),
  effort: z.string().optional(),
})

// A consumer brings zod 3 or 4 as the peer, so this schema uses only what both versions have.
const scorecardSchema = z
  .strictObject({
    version: z.literal(2),
    recorded: z.string().datetime(),
    repo: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, { message: 'is not a commit id' }),
    runner: z.string().min(1),
    models: z.array(modelEntry),
    judges: z.array(modelEntry.omit({ agent: true })).optional(),
    repeat: z.number().int().positive().optional(),
    costUsd: z.number().nonnegative().optional(),
    cases: z.record(z.string(), passCount).optional(),
    measures: z
      .record(z.string(), z.union([passCount, z.strictObject({ value: z.number(), n: count })]))
      .optional(),
  })
  .refine((card) => card.cases !== undefined || card.measures !== undefined, {
    message: 'needs cases, measures or both',
  })

/**
 * The last recorded result of one eval set: version 2 of the file, as every reader of it reads it.
 * `repo` and `commit` name the code it was measured on.
 */
export type Scorecard = z.infer<typeof scorecardSchema>

/**
 * Where a run's result came from: the commit it ran on and whether the checkout had uncommitted
 * changes, and what ran and scored it.
 */
export type Provenance = Pick<Scorecard, 'runner' | 'models' | 'judges'> & {
  commit?: string
  dirty?: boolean
}

/** One model call by the system under test. `effort` is absent when its configuration set none. */
export interface ModelCall {
  agent: string
  model: string
  effort?: string
}

/** Reads a scorecard at the file boundary. A version this reader does not know is rejected. */
export function parseScorecard(value: unknown, file: string): Scorecard {
  const parsed = scorecardSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const problems = parsed.error.issues.map((issue) => [...issue.path, issue.message].join(': '))
  throw new Error(`Invalid scorecard ${file}: ${problems.join('; ')}`)
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const sortedByKey = <T>(entries: Iterable<readonly [string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].toSorted(([a], [b]) => compare(a, b)))

/** Each distinct agent, model and effort among `calls`, in the order a scorecard lists them. */
export function distinctModels(calls: readonly ModelCall[]): ModelCall[] {
  const distinct = new Map(
    calls.map(({ agent, model, effort }) => [
      JSON.stringify([agent, model, effort]),
      { agent, model, ...(effort !== undefined && { effort }) },
    ]),
  )
  return [...distinct.values()].toSorted(
    (a, b) =>
      compare(a.agent, b.agent) ||
      compare(a.model, b.model) ||
      compare(a.effort ?? '', b.effort ?? ''),
  )
}

/** No event keeps the reasoning effort, so these calls carry none. */
export function sessionModelCalls(events: readonly Event[]): ModelCall[] {
  return events.flatMap((event) =>
    event.type === 'model_end' && event.usage?.modelName !== undefined
      ? [{ agent: event.agentName, model: event.usage.modelName }]
      : [],
  )
}

/**
 * Each distinct model the cases' metrics reported calling, such as a judge, sorted. Usage keeps no
 * reasoning effort, so these carry none.
 */
export function judgeModels(results: readonly Pick<BaseEvalCaseResult, 'metrics'>[]) {
  const models = new Set(
    results.flatMap((result) =>
      Object.values(result.metrics).flatMap(
        (metric) => metric.usage?.models.map((entry) => entry.modelName) ?? [],
      ),
    ),
  )
  return [...models].toSorted(compare).map((name) => ({ model: name }))
}

/** `name@version` of this package. */
export function runner(): string {
  const manifest: { name: string; version: string } = require('../../package.json')
  return `${manifest.name}@${manifest.version}`
}

/** A failure carries git's first stderr line. */
function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, maxBuffer: Infinity }, (error, stdout, stderr) =>
      error
        ? fail(new Error(stderr.split('\n')[0].replace(/^(error|fatal): /, '') || error.message))
        : done(stdout),
    )
  })
}

const topLevel = (cwd = process.cwd()) =>
  git(cwd, ['rev-parse', '--show-toplevel']).then((out) => out.trimEnd())

/** The top of the repository that holds `top` as a submodule, and so on outwards. */
async function outermost(top: string): Promise<string> {
  const above = (await git(top, ['rev-parse', '--show-superproject-working-tree'])).trimEnd()
  return above ? outermost(above) : top
}

/** The `owner/name` a remote URL ends in, in lowercase, whatever its form. */
export function repositoryOfRemote(url: string): string | undefined {
  const segments = url
    .trim()
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean)
  return segments.length >= 2 ? segments.slice(-2).join('/').toLowerCase() : undefined
}

/**
 * The commit at `HEAD` of the checkout at `top`, and a `git status` line for each uncommitted
 * change in it, whatever local settings hide. Submodules are left out: each is its own checkout.
 */
export async function checkoutOf(top: string): Promise<{ commit?: string; changes: string[] }> {
  const commit = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    (out) => out.trim(),
    () => undefined,
  )
  const status = ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all']
  const changes = (await git(top, status)).split('\n').filter((line) => line !== '')
  return { ...(commit !== undefined && { commit }), changes }
}

/** Git's status lines as a sentence, five at most. */
export function describeChanges(changes: readonly string[]): string {
  const rest = changes.length > 5 ? `; and ${changes.length - 5} more` : ''
  return `git status reports ${changes
    .slice(0, 5)
    .map((line) => line.trim())
    .join('; ')}${rest}`
}

/**
 * The checkout a run is measured in and, for a suite that declares a scorecard, where that file is:
 * `declared` from the top of the outermost repository that holds the working directory. With no
 * scorecard declared, a git that fails for any reason leaves every key out.
 */
export async function readSource(declared: string | undefined): Promise<{
  source: Pick<Provenance, 'commit' | 'dirty'>
  scorecard?: { file: string; top: string }
}> {
  if (declared === undefined)
    return topLevel()
      .then(checkoutOf)
      .then(
        ({ commit, changes }) => ({
          source: { ...(commit !== undefined && { commit }), dirty: changes.length > 0 },
        }),
        () => ({ source: {} }),
      )
  const top = await topLevel().catch((error: Error) => {
    throw new Error(`A scorecard needs a git repository: ${error.message}`)
  })
  const { commit, changes } = await checkoutOf(top)
  return {
    source: { ...(commit !== undefined && { commit }), dirty: changes.length > 0 },
    scorecard: { file: join(await outermost(top), declared), top },
  }
}

/** The GitHub `owner/name` of the checkout at `top`, from its `origin` remote. */
export async function repositoryOf(top: string): Promise<string> {
  const url = await git(top, ['remote', 'get-url', 'origin']).catch((error: Error) => {
    throw new Error(`--record names the repository from its origin remote: ${error.message}`)
  })
  const repository = repositoryOfRemote(url)
  if (repository === undefined)
    throw new Error(`--record cannot name a repository from the origin ${url.trim()}`)
  return repository
}

/** The JSON in `file`. A file that does not parse is named as an invalid `kind`, with the reason. */
export async function readJson(kind: string, file: string) {
  const text = await readFile(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : error
    throw new Error(`Invalid ${kind} ${file}: ${reason}`, { cause: error })
  }
}

/**
 * The scorecard at `file`, or `undefined` when no file is there. A file that is there and cannot be
 * read is an error, so that a run does not start without the baseline it was meant to have.
 */
export async function readScorecard(file: string): Promise<Scorecard | undefined> {
  const recorded = await readJson('scorecard', file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  return recorded === undefined ? undefined : parseScorecard(recorded, file)
}

/** Atomically replaces the scorecard at `file` with `run`, keeping nothing of the earlier one. */
export async function recordScorecard(
  file: string,
  run: Pick<Scorecard, 'repo' | 'commit' | 'runner' | 'models' | 'judges' | 'costUsd'> & {
    repeat: number
    cases: ReadonlyMap<string, PassCount>
  },
): Promise<void> {
  const scorecard: Scorecard = {
    version: 2,
    recorded: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    repo: run.repo,
    commit: run.commit,
    runner: run.runner,
    models: run.models,
    ...(run.judges !== undefined && { judges: run.judges }),
    repeat: run.repeat,
    ...(run.costUsd !== undefined && { costUsd: run.costUsd }),
    cases: sortedByKey(run.cases),
  }
  await mkdir(dirname(file), { recursive: true })
  // Two runs that record at once would write and rename one shared temporary file.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(scorecard, null, 2)}\n`)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
