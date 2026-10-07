import { mkdir, mkdtemp, readFile, stat, writeFile, rename } from 'node:fs/promises'
import { basename, dirname, resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

import type { AdkApp } from '../api'
import type { Hook } from '../hook/types'
import type { Event } from '../types/events'
import type { ToolChoice } from '../types/runnables'
import type { StateSchema } from '../types/schema'
import type { ComparedRun } from './compare'
import type { AnyEvalCase, AnyEvalCaseResult, MixedEvalOptions } from './types'

import { compareRuns, formatComparison } from './compare'
import { omitUndefinedProperties, serializeEvent, stringifyEvidence, voiceEvidence } from './json'
import { caseJudgeCost, generateReport, suiteCost } from './report'
import { isProcessWorker } from './voice/process-pool'

const RUN_DIRECTORY = '__ADK_EVAL_RUN_DIRECTORY'
const HELP = `Usage: <eval script> list | run [--case <name>]... [--repeat <n>] [--output <directory>]
                                      [--baseline <run>]...

list    List cases without executing them.
run     Evaluate all cases, or each exact --case name.

--baseline  An earlier run directory or its result.json to compare with. Repeat it to pool runs.

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

/**
 * Records each text case's model inputs. Context renderers add instructions that no session event
 * holds, so without this the evidence cannot say which instruction a model call was acting on.
 */
function recordModelInputs<S extends StateSchema>() {
  const bySession = new Map<string, ModelInput[]>()
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
    },
  }
  return { hook, of: (sessionId: string) => bySession.get(sessionId) ?? [] }
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
  repeat?: string
  output?: string
  baseline?: string[]
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
      kind: 'runnable' in item ? 'text' : 'voice',
    })),
  }
}

function selectCases<C extends { name: string }>(cases: C[], names: string[] | undefined): C[] {
  if (names === undefined) return cases
  const known = new Set(cases.map((item) => item.name))
  const unknown = names.filter((name) => !known.has(name))
  if (unknown.length) throw new Error(`Unknown case: ${unknown.join(', ')}`)
  return cases.filter((item) => names.includes(item.name))
}

/** A baseline as the report names it: its run directory. `result.json` keeps the path. */
const runName = (file: string) => basename(dirname(file))

/** The saved runs of each `--baseline`, pooled, read before anything is spent on the run. */
async function readBaselines(
  paths: readonly string[],
): Promise<{ files: string[]; runs: ComparedRun[] } | undefined> {
  if (!paths.length) return undefined
  const files: string[] = []
  const runs: ComparedRun[] = []
  for (const path of paths) {
    const given = resolve(path)
    const file = (await stat(given)).isDirectory() ? join(given, 'result.json') : given
    const saved: { results?: Array<Pick<ComparedRun, 'name' | 'status'> & { evidence: string }> } =
      JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(saved.results)) throw new Error(`Baseline has no results: ${file}`)
    files.push(file)
    for (const { name, status, evidence } of saved.results) {
      // A voice run keeps its durable events as `sessionEvents`, beside the events it observed.
      const kept: { events: Event[]; sessionEvents?: Event[] } = JSON.parse(
        await readFile(evidence, 'utf8'),
      )
      runs.push({ name, status, events: kept.sessionEvents ?? kept.events })
    }
  }
  return { files, runs }
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
        repeat: { type: 'string' },
        output: { type: 'string' },
        baseline: { type: 'string', multiple: true },
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
    const selected = selectCases(cases, values.case)
    const repeat = resolveRepeat(values, options)
    const baseline = worker ? undefined : await readBaselines(values.baseline ?? [])
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
    const comparison = baseline && compareRuns(baseline.runs, result.results.map(comparedRun))
    const report = join(directory, 'report.md')
    await writeFile(
      report,
      generateReport(
        result,
        undefined,
        comparison &&
          `## Compared with baseline\n\n${formatComparison(comparison, baseline.files.map(runName))}`,
      ),
    )
    const expected = selected.length * repeat
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
      ...(baseline && { baseline: baseline.files, comparison }),
      results,
    }
    await writeFile(join(directory, 'result.tmp'), stringifyEvidence(document))
    await rename(join(directory, 'result.tmp'), join(directory, 'result.json'))
    emit(document)
    return result.results.length === expected &&
      result.results.every((item) => item.status === 'passed')
      ? 0
      : 1
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
