import { z } from 'zod'

import type { AskOpts } from '../../agents/ask'
import type { ProviderModelConfig } from '../../types/runnables'
import type { UsageSummary } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'
import type { ZodSchema } from '../../types/zod'
import type { VoiceRunResult } from '../voice/types'
import type { Metric, MetricRun } from './types'

import { openai } from '../../providers/models'
import { renderJudgeEvidence } from './judge-evidence'

export interface JudgeMetricConfig {
  name: string
  /** Criterion id → one observable requirement, phrased by meaning. At least one. */
  criteria: Readonly<Record<string, string>>
  /** Defaults to `openai('gpt-5.4-mini', { reasoning: { effort: 'low' } })`. */
  model?: ProviderModelConfig
  /** Per judge call, parse retries included. Default 60_000. */
  timeoutMs?: number
}

export interface JudgeVerdict {
  reason: string
  passed: boolean
}

/** `MetricResult.data` of a judge metric: every verdict, passing ones included. */
export interface JudgeMetricData {
  model: string
  verdicts: Record<string, JudgeVerdict>
}

/** The result of one `app.ask`, with the usage it spent over every attempt, failed ones included. */
export type AskOutcome<T> =
  | { ok: true; value: T; usage?: UsageSummary }
  | { ok: false; error: unknown; usage?: UsageSummary }

/** `app.ask` that reports its usage and returns its error instead of throwing it. */
export type AskWithUsage = <T>(
  prompt: string,
  opts: AskOpts<T> & { schema: ZodSchema<T> },
) => Promise<AskOutcome<T>>

const DEFAULT_MODEL = openai('gpt-5.4-mini', { reasoning: { effort: 'low' } })

const JUDGE_INSTRUCTIONS = `You judge a recorded conversation between a caller and an agent against a list of requirements.

The user message is JSON. \`requirements\` maps each requirement id to one requirement. \`evidence\` records the run:
- \`status\`: how the run ended.
- \`timeline\`: what happened, in order. \`caller\` and \`agent\` entries carry what was said. \`tool_call\` and \`tool_result\` entries are the agent's tool use.
- \`callerHeard\`: voice calls only. The caller's own transcription of the agent's audio.
- \`finalState\`: the agent's state when the run ended.

Rules:
- The conversation may be in any language, or in several. Judge each requirement by its meaning in the language used. Never require English.
- Quoted text in a requirement is a reference for meaning, unless the requirement says word for word.
- In voice calls, \`said\` is speech recognition output. It may misspell names, split sentences or repeat fragments.
- In voice calls, speech \`fromMs\` and \`toMs\` are audio offsets, and \`atMs\` on tool entries and in \`callerHeard\` is time from the start of the run. The two clocks differ, so use timeline order, not times, to decide whether speech came before or after tool use.
- Judge a requirement about what the caller heard from \`callerHeard\` only.
- Fail a requirement when the evidence is missing or ambiguous, and say what is missing.
- Judge each requirement on its own.

For each requirement id, give \`reason\`, then \`passed\`. \`reason\` is one sentence in English that cites the evidence.`

/**
 * An LLM-judge metric: one model call per run returns a verdict and a reason for each criterion. A
 * failed or malformed call sets `error` with the usage it spent, so the case becomes `error`, never
 * a pass.
 */
export function createJudgeMetric<S extends StateSchema>(
  config: JudgeMetricConfig,
  ask: AskWithUsage,
): Metric<MetricRun<S> | VoiceRunResult<S>> {
  const ids = Object.keys(config.criteria)
  if (!ids.length)
    throw new Error(`[adk] Judge metric "${config.name}" needs at least one criterion`)
  const model = config.model ?? DEFAULT_MODEL
  const timeoutMs = config.timeoutMs ?? 60_000
  const verdict = z.object({ reason: z.string().min(1), passed: z.boolean() })
  const schema = z.object(Object.fromEntries(ids.map((id) => [id, verdict])))

  return {
    name: config.name,
    async evaluate(run) {
      const prompt = JSON.stringify(
        { requirements: config.criteria, evidence: renderJudgeEvidence(run) },
        null,
        2,
      )
      const signal = AbortSignal.timeout(timeoutMs)
      const answer = await ask(prompt, { model, schema, system: JUDGE_INSTRUCTIONS, signal })
      const usage = answer.usage && { usage: answer.usage }
      if (!answer.ok) {
        const error = signal.aborted
          ? `Judge timed out after ${timeoutMs}ms`
          : answer.error instanceof Error
            ? answer.error.message
            : String(answer.error)
        return { passed: false, evidence: [`Metric evaluation failed: ${error}`], error, ...usage }
      }
      const verdicts: Record<string, JudgeVerdict> = {}
      for (const id of ids) {
        const { reason, passed } = answer.value[id]
        verdicts[id] = { reason, passed }
      }
      const failed = ids.filter((id) => !verdicts[id].passed)
      return {
        passed: failed.length === 0,
        evidence: failed.map((id) => `${id}: ${verdicts[id].reason}`),
        data: { model: model.name, verdicts } satisfies JudgeMetricData,
        ...usage,
      }
    },
  }
}
