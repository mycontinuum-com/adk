import type { AdkApp } from '../api'
import type { StateSchema } from '../types/schema'
import type {
  AnyEvalCase,
  AnyEvalCaseResult,
  EvalCase,
  EvalOptions,
  EvalResult,
  MixedEvalOptions,
  MixedEvalResult,
} from './types'
import type { VoiceEvalCase, VoiceEvalOptions } from './voice/types'

import { evaluate as evaluateText } from './simulator'
import { buildSummary, expandCaseRuns, runWithPool } from './suite-runner'
import { isProcessWorker } from './voice/process-pool'

/** Internal overload options that accept either text or mixed progress callbacks. */
export interface EvalDispatchOptions<S extends StateSchema> extends Omit<
  MixedEvalOptions<S>,
  'onCase'
> {
  onCase?(result: AnyEvalCaseResult<S>, index: number, total: number): void
}

/** Evaluates text cases or a mixed text and voice suite through one concurrency budget. */
export function evaluate<S extends StateSchema>(
  app: AdkApp<S>,
  cases: EvalCase<S> | EvalCase<S>[],
  options?: EvalOptions<S>,
): Promise<EvalResult<S>>
export function evaluate<S extends StateSchema>(
  app: AdkApp<S>,
  cases: AnyEvalCase<S> | AnyEvalCase<S>[],
  options?: MixedEvalOptions<S>,
): Promise<MixedEvalResult<S>>
export async function evaluate<S extends StateSchema>(
  app: AdkApp<S>,
  caseOrCases: AnyEvalCase<S> | AnyEvalCase<S>[],
  options: EvalDispatchOptions<S> = {},
): Promise<MixedEvalResult<S>> {
  const cases = Array.isArray(caseOrCases) ? caseOrCases : [caseOrCases]
  const voiceCases = cases.filter((item): item is VoiceEvalCase<S> => !('runnable' in item))
  if (voiceCases.length === 0) {
    const textCases = cases.filter((item): item is EvalCase<S> => 'runnable' in item)
    return evaluateText(app, textCases, options)
  }

  const { evaluateVoice, prepareVoiceEvaluation } = await import('./voice/evaluate.js')
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const voiceOptions: VoiceEvalOptions<S> = {
    ...options.voice,
    schema: app.schema,
    concurrency,
    repeat: options.repeat,
    output: options.output,
    metrics: [...(options.metrics ?? []), ...(options.voice?.metrics ?? [])],
  }
  if (isProcessWorker()) return evaluateVoice(voiceCases, voiceOptions)

  const start = Date.now()
  const voice = prepareVoiceEvaluation(voiceCases, voiceOptions)
  const caseRuns = expandCaseRuns(cases, options.repeat)
  let completed = 0
  let nextVoiceIndex = 0
  const jobs = caseRuns.map((run) => ({
    ...run,
    voiceIndex: 'runnable' in run.item ? -1 : nextVoiceIndex++,
  }))
  const results = await runWithPool(
    jobs,
    async (job): Promise<AnyEvalCaseResult<S>> => {
      let result: AnyEvalCaseResult<S>
      if ('runnable' in job.item) {
        const text = await evaluateText(app, job.item, {
          hooks: options.hooks,
          metrics: options.metrics,
          concurrency: 1,
        })
        result = text.results[0]
        if (job.repeatIndex != null) {
          result.repeatIndex = job.repeatIndex
          result.repeatTotal = job.repeatTotal
        }
      } else {
        result = await voice.runCase(voice.caseRuns[job.voiceIndex], job.voiceIndex)
      }
      options.onCase?.(result, ++completed, jobs.length)
      return result
    },
    concurrency,
    options.stopOnFirstFailure ? (result) => result.status !== 'passed' : undefined,
  )
  return { summary: buildSummary(results), results, durationMs: Date.now() - start }
}
