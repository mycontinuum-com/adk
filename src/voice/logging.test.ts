import { describe, expect, test } from 'vitest'

import { voiceLoggingHook } from './logging'

describe('voiceLoggingHook', () => {
  test('logs output completion and forced tool diagnostics', () => {
    const entries: Record<string, unknown>[] = []
    const hook = voiceLoggingHook({ level: 'debug', onLog: (entry) => entries.push(entry) })

    hook.onVoiceEvent?.({
      type: 'output_tool_completion_failed',
      intendedToolName: 'endCall',
      source: 'output_tool_completion',
      phase: 'generation',
      elapsedMs: 12,
      errorName: 'TypeError',
      errorMessage: 'AgentSession is closing',
    })
    hook.onVoiceEvent?.({
      type: 'forced_tool_correction',
      intendedToolName: 'endCall',
      incorrectToolName: 'transferToHuman',
      attempts: 1,
      maxAttempts: 2,
      source: 'output_tool_completion',
    })

    expect(entries).toEqual([
      expect.objectContaining({
        level: 'INFO',
        type: 'output_tool_completion_failed',
        intendedToolName: 'endCall',
        phase: 'generation',
        errorName: 'TypeError',
        errorMessage: 'AgentSession is closing',
      }),
      expect.objectContaining({
        level: 'INFO',
        type: 'forced_tool_correction',
        intendedToolName: 'endCall',
        incorrectToolName: 'transferToHuman',
        attempts: 1,
        maxAttempts: 2,
      }),
    ])
  })

  test('logs voice activity and lifecycle diagnostics', () => {
    const entries: Record<string, unknown>[] = []
    const hook = voiceLoggingHook({ level: 'debug', onLog: (entry) => entries.push(entry) })

    hook.onVoiceEvent?.({
      type: 'voice_activity',
      activity: 'inactivity_timeout_fired',
      inactivityCount: 0,
      timeoutMs: 6000,
    })
    hook.onVoiceEvent?.({
      type: 'lifecycle_hook_completed',
      hookName: 'onInactivity',
      reason: 'inactivity_timeout',
      inactivityCount: 0,
      result: 'keep_alive',
    })
    hook.onVoiceEvent?.({
      type: 'lifecycle_before_end_failed',
      hookName: 'onDisconnect',
      reason: 'participant_left',
      inactivityCount: 0,
      errorName: 'Error',
      errorMessage: 'failed to finalize',
    })

    expect(entries).toEqual([
      expect.objectContaining({
        level: 'DEBUG',
        type: 'voice_activity',
        activity: 'inactivity_timeout_fired',
        inactivityCount: 0,
        timeoutMs: 6000,
      }),
      expect.objectContaining({
        level: 'DEBUG',
        type: 'lifecycle_hook_completed',
        hookName: 'onInactivity',
        reason: 'inactivity_timeout',
        result: 'keep_alive',
      }),
      expect.objectContaining({
        level: 'INFO',
        type: 'lifecycle_before_end_failed',
        hookName: 'onDisconnect',
        errorName: 'Error',
        errorMessage: 'failed to finalize',
      }),
    ])
  })
})
