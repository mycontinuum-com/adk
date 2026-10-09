import { mkdir, mkdtemp, stat, writeFile, rename } from 'node:fs/promises'
import { basename, dirname, resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

import type { AdkApp } from '../api'
import type { Hook } from '../hook/types'
import type { Event } from '../types/events'
import type { LiveModelConfig, ModelConfig, ToolChoice } from '../types/runnables'
import type { StateSchema } from '../types/schema'
import type { Baseline, ComparedRun } from './compare'
import type { ModelCall, Provenance, Scorecard } from './scorecard'
import type { AnyEvalCase, AnyEvalCaseResult, EvalStatus, MixedEvalOptions } from './types'

import { getInnerModel } from '../providers/models'
import { compareRuns, formatComparison, pooledCounts } from './compare'
import { omitUndefinedProperties, serializeEvent, stringifyEvidence, voiceEvidence } from './json'
import { caseJudgeCost, generateReport, suiteCost } from './report'
import {
  changeSince,
  distinctModels,
  readJson,
  readScorecard,
  readSource,
  recordScorecard,
  runner,
  sessionModelCalls,
} from './scorecard'
import { isProcessWorker } from './voice/process-pool'

const RUN_DIRECTORY = '__ADK_EVAL_RUN_DIRECTORY'
const HELP = `Usage: <eval script> list | run [--case <name>]... [--kind text|voice] [--repeat <n>]
                                      [--output <directory>] [--baseline <run>]... [--record]

list    List cases without executing them.
run     Evaluate all cases, or each exact --case name.

--kind      Evaluate only text or only voice cases. It narrows --case when both are given.
--baseline  An earlier run directory or its result.json to compare with. Repeat it to pool them.
            Without it, a suite that declares a scorecard compares with that.
--record    Replace the suite's scorecard with the result of this run. The paths it fingerprints
            must be committed. A run that did not finish leaves the scorecard as it was.

Results are JSON on stdout. Diagnostics go to stderr.
Exit codes: 0 passed, 1 failed/incomplete, 2 invocation or export error.
`

/** What one model call was given beyond the session's own events. */
interface ModelInput {
  invocationId: string
  agentName: string
  /** The system messages in force, in order. */
  system: string[]
  toolChoice?: ToolChoice
  allowedTools?: readonly string[]
}

function reasoningEffort(config: ModelConfig | LiveModelConfig): string | undefined {
  if ('kind' in config && config.kind === 'live') return undefined
  const model = getInnerModel(config)
  switch (model.provider) {
    case 'openai':
    case 'eurouter':
      return model.reasoning?.effort
    case 'chat-completions':
      return model.reasoningEffort ?? model.chatTemplate?.reasoning_effort
    case 'gemini':
      return model.thinkingConfig?.thinkingLevel
    case 'claude':
      return undefined
    default:
      return model satisfies never
  }
}

/**
 * Records each text case's model inputs. Context renderers add instructions that no session event
 * holds, so without this the evidence cannot say which instruction a model call was acting on.
 * `calls` keeps the model and effort each call asked for, which no event holds.
 */
function recordModelInputs<S extends StateSchema>() {
  const bySession = new Map<string, ModelInput[]>()
  const calls: ModelCall[] = []
  const hook: Hook<S> = {
    name: 'adk.eval.model-inputs',
    beforeModel(ctx, renderCtx) {
      const inputs = bySession.get(ctx.session.id) ?? []
      inputs.push({
        invocationId: renderCtx.invocationId,
        agentName: renderCtx.agentName,
        system: renderCtx.events.flatMap((event) => (event.type === 'system' ? [event.text] : [])),
        toolChoice: renderCtx.toolChoice,
        allowedTools: renderCtx.allowedTools,
      })
      bySession.set(ctx.session.id, inputs)
      calls.push({
        agent: renderCtx.agentName,
        model: renderCtx.agent.model.name,
        effort: reasoningEffort(renderCtx.agent.model),
      })
    },
  }
  return { hook, calls, of: (sessionId: string) => bySession.get(sessionId) ?? [] }
}

/**
 * Model inputs as evidence keeps them: `modelInputs[n]` belongs to the run's n-th `model_start`,
 * and its `system` indexes `instructions`, which holds each distinct message once.
 */
function modelInputEvidence(inputs: readonly ModelInput[]) {
  if (!inputs.length) return {}
  const instructions: string[] = []
  const indexOf = (text: string) => {
    const at = instructions.indexOf(text)
    return at === -1 ? instructions.push(text) - 1 : at
  }
  return {
    modelInputs: inputs.map((input) =>
      omitUndefinedProperties({ ...input, system: input.system.map(indexOf) }),
    ),
    instructions,
  }
}

function caseEvidence(result: AnyEvalCaseResult, inputs: readonly ModelInput[]) {
  if ('events' in result) {
    return {
      events: result.events.map(serializeEvent),
      ...(result.terminationReason === undefined
        ? {}
        : { terminationReason: result.terminationReason }),
      ...modelInputEvidence(inputs),
    }
  }
  return {
    ...voiceEvidence(result.run),
    terminationReason: result.run.status,
  }
}

type CliValues = {
  case?: string[]
  kind?: string
  repeat?: string
  output?: string
  baseline?: string[]
  record?: boolean
  help?: boolean
}

function assertKnownCommand(positionals: string[], command: string): void {
  if (positionals.length !== 1 || (command !== 'list' && command !== 'run')) {
    throw new Error('Expected list or run. Use --help for usage.')
  }
}

function assertUniqueCaseNames(cases: readonly { name: string }[]): void {
  if (!cases.length) throw new Error('The evaluation suite is empty')
  const names = new Set<string>()
  for (const item of cases) {
    if (!item.name.trim() || names.has(item.name))
      throw new Error(`Invalid or duplicate case name: ${item.name}`)
    names.add(item.name)
  }
}

const kindOf = (item: AnyEvalCase<any>) => ('runnable' in item ? 'text' : 'voice')

function caseListDocument<S extends StateSchema>(
  command: string,
  values: CliValues,
  cases: AnyEvalCase<S>[],
) {
  if (Object.values(values).some((value) => value !== undefined))
    throw new Error('Run options cannot be used with list')
  return {
    command,
    source: resolve(process.argv[1]),
    cases: cases.map((item) => ({
      name: item.name,
      ...(item.description === undefined ? {} : { description: item.description }),
      kind: kindOf(item),
    })),
  }
}

/** Selecting no case is an error. */
function selectCases<S extends StateSchema>(
  cases: AnyEvalCase<S>[],
  names: string[] | undefined,
  kind: string | undefined,
): AnyEvalCase<S>[] {
  const known = new Set(cases.map((item) => item.name))
  const unknown = (names ?? []).filter((name) => !known.has(name))
  if (unknown.length) throw new Error(`Unknown case: ${unknown.join(', ')}`)
  if (kind !== undefined && kind !== 'text' && kind !== 'voice')
    throw new Error(`Unknown kind: ${kind}. Expected text or voice.`)
  const selected = cases.filter(
    (item) =>
      (names === undefined || names.includes(item.name)) &&
      (kind === undefined || kindOf(item) === kind),
  )
  if (!selected.length) throw new Error(`No ${kind} case is selected`)
  return selected
}

/** `file` goes in `result.json`; the report names a baseline by `label`. */
interface BaselineSource {
  file: string
  label: string
  baseline: Baseline
}

type Source = Pick<Provenance, 'fingerprint' | 'commit' | 'dirty'>

/** Whether two fingerprints hold the same paths with the same ids. */
function sameIds(recorded: Scorecard['fingerprint'], now: Scorecard['fingerprint']) {
  const paths = Object.keys(recorded)
  return (
    paths.length === Object.keys(now).length && paths.every((path) => recorded[path] === now[path])
  )
}

/**
 * The label says when the scorecard was recorded and, for a suite that declares its files, whether
 * this run is on the same ones: the same paths with the same ids, and nothing uncommitted under
 * them.
 */
function scorecardBaseline(
  file: string,
  scorecard: Scorecard,
  { fingerprint, dirty }: Source,
): BaselineSource {
  const files =
    fingerprint === undefined
      ? ''
      : !dirty && sameIds(scorecard.fingerprint, fingerprint)
        ? ' on these files'
        : ' on different files'
  return {
    file,
    label: `${basename(file)} (recorded ${scorecard.recorded}${files})`,
    baseline: { cases: scorecard.cases },
  }
}

/** The saved run of each `--baseline`, read before anything is spent on the run. */
async function readBaselines(paths: readonly string[]): Promise<BaselineSource[]> {
  const sources: BaselineSource[] = []
  for (const path of paths) {
    const given = resolve(path)
    const file = (await stat(given)).isDirectory() ? join(given, 'result.json') : given
    const saved: {
      results?: Array<Pick<ComparedRun, 'name' | 'status'> & { evidence: string }>
    } = await readJson('baseline', file)
    if (!Array.isArray(saved.results)) throw new Error(`Baseline has no results: ${file}`)
    const runs: ComparedRun[] = []
    for (const { name, status, evidence } of saved.results) {
      // A voice run keeps its durable events as `sessionEvents`, beside the events it observed.
      const kept: { events: Event[]; sessionEvents?: Event[] } = await readJson(
        'baseline',
        evidence,
      )
      runs.push({ name, status, events: kept.sessionEvents ?? kept.events })
    }
    sources.push({ file, label: basename(dirname(file)), baseline: { runs } })
  }
  return sources
}

interface StartingPoint {
  source: Source
  baselines: BaselineSource[]
  /** With `--record`: the scorecard to replace, and how many cases it holds now if it exists. */
  record?: { file: string; fingerprint: Scorecard['fingerprint']; held?: number }
}

async function readStartingPoint<S extends StateSchema>(
  values: CliValues,
  { scorecard }: MixedEvalOptions<S>,
): Promise<StartingPoint> {
  if (values.record && !scorecard)
    throw new Error('--record needs a scorecard: set `scorecard` in the options of evaluate.cli')
  const source = await readSource(scorecard)
  const { fingerprint } = source
  const file = scorecard && resolve(scorecard.path)
  const recording = values.record && file !== undefined && fingerprint !== undefined
  // A scorecard records its paths as they are at `HEAD`, which is not what a dirty tree measures.
  const change = recording ? await changeSince(fingerprint) : undefined
  if (change !== undefined)
    throw new Error(
      `--record needs its fingerprint paths committed, and ${change}. Commit first, then record.`,
    )
  const previous =
    file !== undefined && (values.record || !values.baseline)
      ? await readScorecard(file)
      : undefined
  return {
    source,
    baselines: values.baseline
      ? await readBaselines(values.baseline)
      : file !== undefined && previous
        ? [scorecardBaseline(file, previous, source)]
        : [],
    ...(recording && {
      record: { file, fingerprint, held: previous && Object.keys(previous.cases).length },
    }),
  }
}

function resolveRepeat<S extends StateSchema>(
  values: CliValues,
  options: MixedEvalOptions<S>,
): number {
  const repeat = values.repeat === undefined ? (options.repeat ?? 1) : Number(values.repeat)
  if (!Number.isSafeInteger(repeat) || repeat < 1)
    throw new Error('repeat must be a positive integer')
  if (
    options.concurrency !== undefined &&
    (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
  ) {
    throw new Error('concurrency must be a positive integer')
  }
  return repeat
}

async function prepareRunDirectory<S extends StateSchema>(
  worker: boolean,
  originalRunDirectory: string | undefined,
  values: CliValues,
  options: MixedEvalOptions<S>,
): Promise<string> {
  if (worker) {
    if (!originalRunDirectory) throw new Error('Voice worker is missing the parent run directory')
    return originalRunDirectory
  }
  const root = resolve(values.output ?? options.output ?? '.adk/evals')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'run-'))
  process.env[RUN_DIRECTORY] = directory
  return directory
}

const comparedRun = (item: AnyEvalCaseResult): ComparedRun => ({
  name: item.name,
  status: item.status,
  events: 'events' in item ? item.events : item.run.session.events,
})

function provenanceOf(
  source: StartingPoint['source'],
  calls: readonly ModelCall[],
  results: readonly AnyEvalCaseResult[],
): Provenance {
  return {
    ...source,
    runner: runner(),
    models: distinctModels([
      ...calls,
      ...results.flatMap((item) =>
        'events' in item ? [] : sessionModelCalls(item.run.session.events),
      ),
    ]),
  }
}

const REACHED_VERDICT: Record<EvalStatus, boolean> = {
  passed: true,
  failed: true,
  // Stopped at a limit its case sets, or its call ended early: the runner scores it as not passed.
  terminated: true,
  error: false,
  timeout: false,
  aborted: false,
}

function unfinishedReason(
  results: readonly AnyEvalCaseResult[],
  expected: number,
): string | undefined {
  if (results.length !== expected) return `${results.length} of ${expected} runs completed`
  const statuses = results.map((item) => item.status).filter((status) => !REACHED_VERDICT[status])
  if (!statuses.length) return undefined
  const distinct = [...new Set(statuses)].join(', ')
  return `${statuses.length} of ${expected} runs ended without a verdict (${distinct})`
}

/** Why the files are no longer the ones the run started on, or `undefined` when they still are. */
async function changedDuringRun(fingerprint: Scorecard['fingerprint']) {
  const change = await changeSince(fingerprint).catch((error: Error) => error.message)
  return change === undefined
    ? undefined
    : `the fingerprint paths changed during the run, and ${change}`
}

/** What `--record` did to the scorecard at `file`. */
interface Recording {
  file: string
  written: boolean
}

/**
 * Replaces the scorecard with these runs and says so on stderr. When a run is unfinished, the files
 * changed while it ran or the file cannot be written, the scorecard stays as it was and stderr says
 * why.
 */
async function record(
  { file, fingerprint, held }: NonNullable<StartingPoint['record']>,
  provenance: Provenance,
  repeat: number,
  results: readonly AnyEvalCaseResult[],
  expected: number,
): Promise<Recording> {
  const cases = pooledCounts([{ runs: results.map(comparedRun) }])
  const { total } = suiteCost(results)
  const why =
    unfinishedReason(results, expected) ??
    (await changedDuringRun(fingerprint)) ??
    (await recordScorecard(file, {
      fingerprint,
      runner: provenance.runner,
      models: provenance.models,
      repeat,
      ...(total.basis !== 'unavailable' && { costUsd: Math.round(total.totalCost * 100) / 100 }),
      cases,
    }).then(
      () => undefined,
      (error: Error) => error.message,
    ))
  process.stderr.write(
    why === undefined
      ? `Recorded ${file}. Cases: ${cases.size} now, ${held ?? 'no file'} before.\n`
      : `Not recorded ${file}: ${why}.\n`,
  )
  return { file, written: why === undefined }
}

/** 0 only when every expected run passed and, with `--record`, the scorecard was written. */
function exitCode(
  results: readonly AnyEvalCaseResult[],
  expected: number,
  recording: Recording | undefined,
): 0 | 1 {
  const passed = results.length === expected && results.every((item) => item.status === 'passed')
  return passed && recording?.written !== false ? 0 : 1
}

function caseResultEntry(item: AnyEvalCaseResult, evidence: string) {
  return omitUndefinedProperties({
    name: item.name,
    kind: 'events' in item ? 'text' : 'voice',
    status: item.status,
    metrics: item.metrics,
    durationMs: item.durationMs,
    usage: item.usage,
    liveUsage: 'events' in item ? undefined : item.run.liveUsage,
    judgeCost: caseJudgeCost(item),
    attempts: item.attempts,
    repeatIndex: item.repeatIndex,
    repeatTotal: item.repeatTotal,
    error: item.error,
    evidence,
  })
}

/** Runs a product-owned evaluation suite from process arguments and returns its exit code. */
export async function evalCli<S extends StateSchema>(
  app: AdkApp<S>,
  cases: AnyEvalCase<S>[],
  options: MixedEvalOptions<S> = {},
): Promise<0 | 1 | 2> {
  const stdout = process.stdout.write
  const originalRunDirectory = process.env[RUN_DIRECTORY]
  const worker = isProcessWorker()
  let command = 'run'
  let directory: string | undefined
  const emit = (value: unknown) => stdout.call(process.stdout, `${stringifyEvidence(value)}\n`)
  process.stdout.write = process.stderr.write.bind(process.stderr)
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2).filter((arg) => arg !== '--'),
      allowPositionals: true,
      options: {
        case: { type: 'string', multiple: true },
        kind: { type: 'string' },
        repeat: { type: 'string' },
        output: { type: 'string' },
        baseline: { type: 'string', multiple: true },
        record: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    if (values.help) {
      stdout.call(process.stdout, HELP)
      return 0
    }
    command = positionals[0] ?? ''
    assertKnownCommand(positionals, command)
    assertUniqueCaseNames(cases)
    if (command === 'list') {
      emit(caseListDocument(command, values, cases))
      return 0
    }
    const selected = selectCases(cases, values.case, values.kind)
    const repeat = resolveRepeat(values, options)
    const start: StartingPoint = worker
      ? { source: {}, baselines: [] }
      : await readStartingPoint(values, options)
    directory = await prepareRunDirectory(worker, originalRunDirectory, values, options)
    const inputs = recordModelInputs<S>()
    const result = await app.evaluate(selected, {
      ...options,
      hooks: [...(options.hooks ?? []), inputs.hook],
      repeat,
      output: join(directory, 'voice'),
      onCase: (item, index, total) => {
        process.stderr.write(`[${index}/${total}] ${item.name}: ${item.status}\n`)
        options.onCase?.(item, index, total)
      },
    })
    const results = []
    for (const [index, item] of result.results.entries()) {
      const evidence = join(directory, `case-${index + 1}.json`)
      const given = 'events' in item ? inputs.of(item.run.session.id) : []
      await writeFile(evidence, stringifyEvidence(caseEvidence(item, given)))
      results.push(caseResultEntry(item, evidence))
    }
    const comparison =
      start.baselines.length > 0
        ? compareRuns(
            start.baselines.map((source) => source.baseline),
            result.results.map(comparedRun),
          )
        : undefined
    const report = join(directory, 'report.md')
    await writeFile(
      report,
      generateReport(
        result,
        undefined,
        comparison &&
          `## Compared with baseline\n\n${formatComparison(
            comparison,
            start.baselines.map((source) => source.label),
          )}`,
      ),
    )
    const expected = selected.length * repeat
    const provenance = provenanceOf(start.source, inputs.calls, result.results)
    const recording =
      start.record && (await record(start.record, provenance, repeat, result.results, expected))
    const document = {
      command,
      source: resolve(process.argv[1]),
      directory,
      report,
      selected: selected.map((item) => item.name),
      repeat,
      expected,
      completed: result.results.length,
      summary: result.summary,
      cost: suiteCost(result.results),
      durationMs: result.durationMs,
      provenance,
      ...(recording && { record: recording }),
      ...(comparison && { baseline: start.baselines.map((source) => source.file), comparison }),
      results,
    }
    await writeFile(join(directory, 'result.tmp'), stringifyEvidence(document))
    await rename(join(directory, 'result.tmp'), join(directory, 'result.json'))
    emit(document)
    return exitCode(result.results, expected, recording)
  } catch (error) {
    if (worker) throw error
    emit({
      command,
      ...(directory === undefined ? {} : { directory }),
      error: { message: error instanceof Error ? error.message : String(error) },
    })
    return 2
  } finally {
    process.stdout.write = stdout
    if (originalRunDirectory === undefined) delete process.env[RUN_DIRECTORY]
    else process.env[RUN_DIRECTORY] = originalRunDirectory
  }
}
