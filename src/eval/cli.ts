import { mkdir, mkdtemp, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

import type { AdkApp } from '../api'
import type { StateSchema } from '../types/schema'
import type { AnyEvalCase, AnyEvalCaseResult, MixedEvalOptions } from './types'

import { omitUndefinedProperties, serializeEvent, stringifyEvidence, voiceEvidence } from './json'
import { caseJudgeCost, generateReport, suiteCost } from './report'
import { isProcessWorker } from './voice/process-pool'

const RUN_DIRECTORY = '__ADK_EVAL_RUN_DIRECTORY'
const HELP = `Usage: <eval script> list | run [--case <name>] [--repeat <n>] [--output <directory>]

list    List cases without executing them.
run     Evaluate all cases, or one exact --case name.

Results are JSON on stdout. Diagnostics go to stderr.
Exit codes: 0 passed, 1 failed/incomplete, 2 invocation or export error.
`

function caseEvidence(result: AnyEvalCaseResult) {
  if ('events' in result) {
    return {
      events: result.events.map(serializeEvent),
      ...(result.terminationReason === undefined
        ? {}
        : { terminationReason: result.terminationReason }),
    }
  }
  return {
    ...voiceEvidence(result.run),
    terminationReason: result.run.status,
  }
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
        case: { type: 'string' },
        repeat: { type: 'string' },
        output: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    if (values.help) {
      stdout.call(process.stdout, HELP)
      return 0
    }
    command = positionals[0] ?? ''
    if (positionals.length !== 1 || (command !== 'list' && command !== 'run')) {
      throw new Error('Expected list or run. Use --help for usage.')
    }
    if (!cases.length) throw new Error('The evaluation suite is empty')
    const names = new Set<string>()
    for (const item of cases) {
      if (!item.name.trim() || names.has(item.name))
        throw new Error(`Invalid or duplicate case name: ${item.name}`)
      names.add(item.name)
    }
    if (command === 'list') {
      if (values.case !== undefined || values.repeat !== undefined || values.output !== undefined)
        throw new Error('Run options cannot be used with list')
      emit({
        command,
        source: resolve(process.argv[1]),
        cases: cases.map((item) => ({
          name: item.name,
          ...(item.description === undefined ? {} : { description: item.description }),
          kind: 'runnable' in item ? 'text' : 'voice',
        })),
      })
      return 0
    }
    const selected =
      values.case === undefined ? cases : cases.filter((item) => item.name === values.case)
    if (!selected.length) throw new Error(`Unknown case: ${values.case}`)
    const repeat = values.repeat === undefined ? (options.repeat ?? 1) : Number(values.repeat)
    if (!Number.isSafeInteger(repeat) || repeat < 1)
      throw new Error('repeat must be a positive integer')
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    ) {
      throw new Error('concurrency must be a positive integer')
    }
    if (worker) {
      directory = originalRunDirectory
      if (!directory) throw new Error('Voice worker is missing the parent run directory')
    } else {
      const root = resolve(values.output ?? options.output ?? '.adk/evals')
      await mkdir(root, { recursive: true })
      directory = await mkdtemp(join(root, 'run-'))
      process.env[RUN_DIRECTORY] = directory
    }
    const result = await app.evaluate(selected, {
      ...options,
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
      await writeFile(evidence, stringifyEvidence(caseEvidence(item)))
      results.push(
        omitUndefinedProperties({
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
        }),
      )
    }
    const report = join(directory, 'report.md')
    await writeFile(report, generateReport(result))
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
