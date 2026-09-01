import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { StateSchema } from '../../types/schema'
import type { MetricResult } from '../metrics/types'
import type { EvalStatus } from '../types'
import type { VoiceEvalCase, VoiceRunResult, VoiceTiming } from './types'

import { getModelName } from '../../providers/models'
import { formatCost } from '../../providers/pricing'
import { sanitize } from '../../voice/recording'

export interface CaseWriter {
  appendLine(text: string): void
  writeResult(
    status: EvalStatus,
    result: VoiceRunResult,
    metrics: Record<string, MetricResult>,
    attempts: number,
  ): void
}

function formatMs(ms: number): string {
  return (ms / 1000).toFixed(1) + 's'
}

function renderHeader<S extends StateSchema>(evalCase: VoiceEvalCase<S>): string {
  const lines: string[] = []
  lines.push(`# ${evalCase.name}`)
  lines.push('')
  if (evalCase.description) {
    lines.push(`> ${evalCase.description}`)
    lines.push('')
  }
  const agentModel = getModelName(evalCase.agent.model) ?? 'unknown'
  const userModel = getModelName(evalCase.userAgent.model) ?? 'unknown'
  lines.push(`**Agent**: ${evalCase.agent.name} (${agentModel})`)
  lines.push(`**User**: ${evalCase.userAgent.name} (${userModel})`)
  lines.push('')
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

function renderTiming(timing: VoiceTiming): string[] {
  const lines: string[] = []
  if (timing.timeToFirstSpeechMs != null) {
    lines.push(`- Time to first speech: ${Math.round(timing.timeToFirstSpeechMs)}ms`)
  }
  const agentResponses = timing.responseTimes.filter((r) => r.speaker === 'agent' || !r.speaker)
  const userResponses = timing.responseTimes.filter((r) => r.speaker === 'user')
  if (agentResponses.length > 0) {
    const values = agentResponses.map((r) => `${Math.round(r.ms)}ms`).join(', ')
    lines.push(`- Agent response latencies: ${values}`)
  }
  if (userResponses.length > 0) {
    const values = userResponses.map((r) => `${Math.round(r.ms)}ms`).join(', ')
    lines.push(`- User agent response latencies: ${values}`)
  }
  if (timing.silenceGaps.length > 0) {
    const values = timing.silenceGaps.map((g) => `${Math.round(g.ms)}ms`).join(', ')
    lines.push(`- Silence gaps: ${values}`)
  }
  lines.push(`- Interruptions: ${timing.interruptions.count}`)
  return lines
}

function renderVoiceDiagnostics(result: VoiceRunResult): string[] {
  const lines: string[] = []
  for (const event of result.voiceEvents ?? []) {
    const at = formatMs(event.createdAt - result.startedAtMs)
    switch (event.type) {
      case 'voice_activity':
        lines.push(
          `${at} voice_activity(${event.activity}${event.inactivityCount !== undefined ? `, inactivityCount=${event.inactivityCount}` : ''}${event.timeoutMs !== undefined ? `, timeoutMs=${event.timeoutMs}` : ''}${event.reason ? `, reason=${event.reason}` : ''})`,
        )
        break
      case 'lifecycle_hook_started':
        lines.push(
          `${at} lifecycle_hook_started(${event.hookName}, reason=${event.reason}, inactivityCount=${event.inactivityCount}, hooks=${event.hookCount})`,
        )
        break
      case 'lifecycle_hook_completed':
        lines.push(
          `${at} lifecycle_hook_completed(${event.hookName}, reason=${event.reason}, result=${event.result}, inactivityCount=${event.inactivityCount})`,
        )
        break
      case 'lifecycle_hook_failed':
        lines.push(
          `${at} lifecycle_hook_failed(${event.hookName}, reason=${event.reason}, inactivityCount=${event.inactivityCount}, error=${event.errorName}: ${event.errorMessage})`,
        )
        break
      case 'lifecycle_before_end_started':
        lines.push(
          `${at} lifecycle_before_end_started(${event.hookName}, reason=${event.reason}, inactivityCount=${event.inactivityCount})`,
        )
        break
      case 'lifecycle_before_end_completed':
        lines.push(
          `${at} lifecycle_before_end_completed(${event.hookName}, reason=${event.reason}, inactivityCount=${event.inactivityCount})`,
        )
        break
      case 'lifecycle_before_end_failed':
        lines.push(
          `${at} lifecycle_before_end_failed(${event.hookName}, reason=${event.reason}, inactivityCount=${event.inactivityCount}, error=${event.errorName}: ${event.errorMessage})`,
        )
        break
      case 'output_tool_completion_started':
        lines.push(`${at} output_tool_completion_started(${event.intendedToolName})`)
        break
      case 'output_tool_completion_succeeded':
        lines.push(
          `${at} output_tool_completion_succeeded(${event.intendedToolName}, ${event.elapsedMs}ms)`,
        )
        break
      case 'output_tool_completion_failed': {
        const forcedDetails = event.forcedToolReason
          ? [
              `forcedReason=${event.forcedToolReason}`,
              `actual=${event.incorrectToolName ?? 'none'}`,
              `attempt=${event.attempts ?? 'n/a'}/${event.maxAttempts ?? 'n/a'}`,
            ].join(', ')
          : ''
        const failureDetails = [
          `phase=${event.phase}`,
          ...(forcedDetails ? [forcedDetails] : []),
          `error=${event.errorName}: ${event.errorMessage}`,
        ].join(', ')
        lines.push(
          `${at} output_tool_completion_failed(${event.intendedToolName}, ${failureDetails})`,
        )
        break
      }
      case 'forced_tool_correction':
        lines.push(
          `${at} forced_tool_correction(expected=${event.intendedToolName}, actual=${event.incorrectToolName ?? 'none'}, attempt=${event.attempts}/${event.maxAttempts})`,
        )
        break
      case 'forced_tool_failure':
        lines.push(
          `${at} forced_tool_failure(expected=${event.intendedToolName}, actual=${event.incorrectToolName ?? 'none'}, attempt=${event.attempts}/${event.maxAttempts})`,
        )
        break
    }
  }
  return lines
}

function renderResult(
  status: EvalStatus,
  result: VoiceRunResult,
  metrics: Record<string, MetricResult>,
  attempts: number,
): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('')
  lines.push(`## Result: ${status}`)
  lines.push('')
  const costStr = result.usage?.cost ? ` — ${formatCost(result.usage.cost.totalCost)}` : ''
  lines.push(`**Duration**: ${formatMs(result.durationMs)}${costStr}`)
  if (result.recording.path) {
    lines.push(`**Recording**: [recording.wav](./recording.wav)`)
  }
  if (attempts > 1) {
    lines.push(`**Attempts**: ${attempts}`)
  }
  if (result.error) {
    lines.push(`**Error**: ${result.error.message}`)
  }
  lines.push('')

  const timingLines = renderTiming(result.timing)
  if (timingLines.length > 0) {
    lines.push('### Timing')
    lines.push('')
    lines.push(...timingLines)
    lines.push('')
  }

  const diagnosticLines = renderVoiceDiagnostics(result)
  if (diagnosticLines.length > 0) {
    lines.push('### Voice Diagnostics')
    lines.push('')
    lines.push(...diagnosticLines.map((line) => `- ${line}`))
    lines.push('')
  }

  const metricEntries = Object.entries(metrics)
  if (metricEntries.length > 0) {
    lines.push('### Metrics')
    lines.push('')
    for (const [name, m] of metricEntries) {
      const tag = m.passed ? 'PASS' : 'FAIL'
      const evidence = m.evidence?.join(', ') ?? ''
      lines.push(`- [${tag}] ${name}${evidence ? ` — ${evidence}` : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function createCaseWriter<S extends StateSchema>(
  outputDir: string,
  evalCase: VoiceEvalCase<S>,
  dirName?: string,
): CaseWriter {
  const caseDir = join(outputDir, dirName ?? sanitize(evalCase.name))
  mkdirSync(caseDir, { recursive: true })

  const filePath = join(caseDir, 'report.md')
  writeFileSync(filePath, renderHeader(evalCase))

  return {
    appendLine(text: string) {
      appendFileSync(filePath, text + '\n\n')
    },

    writeResult(status, result, metrics, attempts) {
      appendFileSync(filePath, renderResult(status, result, metrics, attempts))
    },
  }
}
