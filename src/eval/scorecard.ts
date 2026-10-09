import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

import type { Event } from '../types/events'
import type { PassCount } from './compare'
import type { MixedEvalOptions } from './types'

const passCount = z
  .object({ passed: z.number().int().nonnegative(), runs: z.number().int().nonnegative() })
  .refine((count) => count.passed <= count.runs, { message: 'passed is more than runs' })

const scorecardSchema = z.object({
  version: z.literal(1),
  recorded: z.string(),
  fingerprint: z
    .record(z.string(), z.string())
    .refine((ids) => Object.keys(ids).length > 0, { message: 'lists no path' }),
  runner: z.string(),
  models: z.array(
    z.object({ agent: z.string().optional(), model: z.string(), effort: z.string().optional() }),
  ),
  repeat: z.number().optional(),
  costUsd: z.number().optional(),
  cases: z.record(z.string(), passCount, {
    message: 'this CLI compares cases, and the file has none',
  }),
})

/**
 * The last recorded result of one eval set: version 1 of the file a suite commits, as this CLI
 * reads it. `fingerprint` maps each file or directory the result depends on to git's id of it.
 */
export type Scorecard = z.infer<typeof scorecardSchema>

/**
 * Where a run's result came from: git's ids of the declared files, the commit they sat on and
 * whether they had uncommitted changes, and what ran it. A run of a suite that declares no
 * scorecard has no `fingerprint`.
 */
export type Provenance = Pick<Scorecard, 'runner' | 'models'> &
  Partial<Pick<Scorecard, 'fingerprint'>> & { commit?: string; dirty?: boolean }

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

const byUtf8Bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

const sortedByKey = <T>(entries: Iterable<readonly [string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].toSorted(([a], [b]) => byUtf8Bytes(a, b)))

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
      byUtf8Bytes(a.agent, b.agent) ||
      byUtf8Bytes(a.model, b.model) ||
      byUtf8Bytes(a.effort ?? '', b.effort ?? ''),
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

/** `name@version` of this package. */
export function runner(): string {
  const manifest: { name: string; version: string } = require('../../package.json')
  return `${manifest.name}@${manifest.version}`
}

/** A failure carries git's first stderr line, which names the path at fault. */
function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, maxBuffer: Infinity }, (error, stdout, stderr) =>
      error
        ? fail(new Error(stderr.split('\n')[0].replace(/^(error|fatal): /, '') || error.message))
        : done(stdout),
    )
  })
}

const idAtHead = (top: string, path: string) =>
  git(top, ['rev-parse', `HEAD:${path}`]).then(
    (out) => out.trimEnd(),
    (error: Error) => {
      throw new Error(`Scorecard fingerprint: ${error.message}`)
    },
  )

/**
 * Git's id at `HEAD` of each of `paths` in the repository at `top`: a file's blob id, and a
 * directory's tree id, which changes when anything committed under it changes. Each path is from
 * `top` with forward slashes. A path that is not in `HEAD` is an error that names it.
 */
export async function fingerprintOf(
  top: string,
  paths: readonly string[],
): Promise<Scorecard['fingerprint']> {
  const ids = await Promise.all(paths.map((path) => idAtHead(top, path)))
  return sortedByKey(paths.map((path, index) => [path, ids[index]] as const))
}

const withinRepository = (top: string, path: string) =>
  relative(top, resolve(path)).split(sep).join('/') || '.'

/** Whether `file` is `path` or lies under it, both from the top of one repository. */
const holds = (path: string, file: string) => relative(path, file).split(sep)[0] !== '..'

const topLevel = (cwd = process.cwd()) =>
  git(cwd, ['rev-parse', '--show-toplevel']).then((out) => out.trimEnd())

const isDirectory = (path: string) =>
  stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  )

/**
 * Where git places `file`: the top of the repository that holds it and its path from there, or
 * `undefined` when no repository does. Git is asked in the nearest directory above the file that
 * exists, and it follows links. So a file inside a submodule belongs to the submodule, and a file
 * declared through a linked directory is placed where the link points.
 */
async function placeOf(file: string): Promise<{ top: string; path: string } | undefined> {
  let directory = dirname(file)
  while (directory !== dirname(directory) && !(await isDirectory(directory)))
    directory = dirname(directory)
  const below = relative(directory, file).split(sep)
  return git(directory, ['rev-parse', '--show-toplevel', '--show-prefix']).then(
    (out) => {
      const [top, prefix] = out.split('\n')
      return { top, path: [...prefix.split('/').filter(Boolean), ...below].join('/') }
    },
    () => undefined,
  )
}

/**
 * One `git status` line for each uncommitted change under `paths`, whatever local settings hide.
 * The paths are names, not patterns: `--literal-pathspecs` keeps `*` and `[` from matching others.
 */
async function changesUnder(top: string, paths: readonly string[]): Promise<string[]> {
  const shown = ['--untracked-files=all', '--ignore-submodules=none']
  const status = ['--literal-pathspecs', 'status', '--porcelain', ...shown, '--', ...paths]
  const lines = await git(top, status)
  return lines.split('\n').filter((line) => line !== '')
}

async function commitAndDirty(
  top: string,
  paths: readonly string[],
): Promise<Pick<Provenance, 'commit' | 'dirty'>> {
  const commit = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    (out) => out.trim(),
    () => undefined,
  )
  const dirty = (await changesUnder(top, paths)).length > 0
  return { ...(commit !== undefined && { commit }), dirty }
}

/**
 * What git reports under the paths of `fingerprint` that it did not when the fingerprint was read,
 * or `undefined` when the files are the same: its status line for each uncommitted change, five at
 * most, or else the paths whose id at `HEAD` is another now.
 */
export async function changeSince(
  fingerprint: Scorecard['fingerprint'],
  cwd = process.cwd(),
): Promise<string | undefined> {
  const top = await topLevel(cwd)
  const paths = Object.keys(fingerprint)
  const changes = (await changesUnder(top, paths)).map((line) => line.trim())
  if (changes.length) {
    const rest = changes.length > 5 ? `; and ${changes.length - 5} more` : ''
    return `git status reports ${changes.slice(0, 5).join('; ')}${rest}`
  }
  const now = await fingerprintOf(top, paths)
  const moved = paths.filter((path) => now[path] !== fingerprint[path])
  return moved.length ? `HEAD has another id for ${moved.join(', ')}` : undefined
}

/**
 * The repository state a run is measured on. With no scorecard declared, a git that fails for any
 * reason leaves every key out. With one, the failure is an error that carries git's own words. So
 * is a scorecard in another repository than its paths, such as a submodule, where a reader would
 * look the paths up in the wrong repository, and one inside a path it fingerprints, where
 * committing it would change that path's id.
 */
export async function readSource(
  declared: MixedEvalOptions['scorecard'],
): Promise<Pick<Provenance, 'fingerprint' | 'commit' | 'dirty'>> {
  if (!declared)
    return topLevel()
      .then((top) => commitAndDirty(top, []))
      .catch(() => ({}))
  const top = await topLevel().catch((error: Error) => {
    throw new Error(`A scorecard needs a git repository: ${error.message}`)
  })
  const paths = [...new Set(declared.fingerprint.map((path) => withinRepository(top, path)))]
  if (!paths.length) throw new Error('scorecard.fingerprint lists no path')
  const file = resolve(declared.path)
  const place = await placeOf(file)
  if (place === undefined || place.top !== top) {
    const placed = place === undefined ? '' : ` (git places it in ${place.top})`
    throw new Error(
      `The scorecard ${file} is not in ${top}, the repository that holds its fingerprint paths${placed}. Keep it in the repository of its paths.`,
    )
  }
  const scorecard = place.path
  const holder = paths.find((path) => holds(path, scorecard))
  if (holder !== undefined)
    throw new Error(
      `The scorecard ${scorecard} is inside ${holder}, a path it fingerprints. Keep it outside its fingerprint paths.`,
    )
  return { fingerprint: await fingerprintOf(top, paths), ...(await commitAndDirty(top, paths)) }
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
  run: Pick<Scorecard, 'fingerprint' | 'runner' | 'models' | 'costUsd'> & {
    repeat: number
    cases: ReadonlyMap<string, PassCount>
  },
): Promise<void> {
  const scorecard: Scorecard = {
    version: 1,
    recorded: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    fingerprint: run.fingerprint,
    runner: run.runner,
    models: run.models,
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
