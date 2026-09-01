import { describe, expect, test, vi } from 'vitest'

import { ForcedToolCallError } from './forced-tool-gate'
import { createOutputToolCompletion, OutputToolCompletionError } from './output-tool-completion'

describe('output tool completion diagnostics', () => {
  test('timeout rejects and emits a typed failure event', async () => {
    vi.useFakeTimers()
    const events: any[] = []
    const completion = createOutputToolCompletion({
      intendedToolName: 'endCall',
      source: 'output_tool_completion',
      timeoutMs: 1000,
      onVoiceEvent: (event) => events.push(event),
    })

    const promise = completion.wait()
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).rejects.toBeInstanceOf(OutputToolCompletionError)
    expect(events.map((event) => event.type)).toEqual([
      'output_tool_completion_started',
      'output_tool_completion_failed',
    ])
    expect(events[1]).toMatchObject({
      type: 'output_tool_completion_failed',
      intendedToolName: 'endCall',
      source: 'output_tool_completion',
      phase: 'timeout',
      errorName: 'OutputToolCompletionError',
      errorMessage: expect.stringContaining('Timed out waiting for output tool endCall'),
    })

    vi.useRealTimers()
  })

  test('complete emits a success event with elapsed time', async () => {
    vi.useFakeTimers()
    const events: any[] = []
    const completion = createOutputToolCompletion({
      intendedToolName: 'endCall',
      source: 'output_tool_completion',
      timeoutMs: 1000,
      onVoiceEvent: (event) => events.push(event),
    })

    const promise = completion.wait()
    await vi.advanceTimersByTimeAsync(25)
    completion.complete()
    await promise

    expect(events.map((event) => event.type)).toEqual([
      'output_tool_completion_started',
      'output_tool_completion_succeeded',
    ])
    expect(events[1]).toMatchObject({
      type: 'output_tool_completion_succeeded',
      intendedToolName: 'endCall',
      source: 'output_tool_completion',
      elapsedMs: 25,
    })

    vi.useRealTimers()
  })

  test('fail sanitizes arbitrary generation errors', async () => {
    const events: any[] = []
    const completion = createOutputToolCompletion({
      intendedToolName: 'endCall',
      source: 'output_tool_completion',
      timeoutMs: 1000,
      onVoiceEvent: (event) => events.push(event),
    })

    const promise = completion.wait()
    completion.fail('generation', new TypeError('AgentSession is closing'))

    await expect(promise).rejects.toMatchObject({
      intendedToolName: 'endCall',
      phase: 'generation',
    })
    expect(events[1]).toMatchObject({
      type: 'output_tool_completion_failed',
      intendedToolName: 'endCall',
      phase: 'generation',
      errorName: 'TypeError',
      errorMessage: 'AgentSession is closing',
    })
  })

  test('fail preserves forced-tool failure diagnostics', async () => {
    const events: any[] = []
    const completion = createOutputToolCompletion({
      intendedToolName: 'endCall',
      source: 'output_tool_completion',
      timeoutMs: 1000,
      onVoiceEvent: (event) => events.push(event),
    })

    const promise = completion.wait()
    completion.fail(
      'forced_tool',
      new ForcedToolCallError({
        intendedToolName: 'endCall',
        incorrectToolName: 'transferToHuman',
        attempts: 2,
        maxAttempts: 2,
        source: 'output_tool_completion',
        reason: 'exhausted',
      }),
    )

    await expect(promise).rejects.toMatchObject({
      intendedToolName: 'endCall',
      phase: 'forced_tool',
      forcedToolReason: 'exhausted',
    })
    expect(events[1]).toMatchObject({
      type: 'output_tool_completion_failed',
      intendedToolName: 'endCall',
      phase: 'forced_tool',
      forcedToolReason: 'exhausted',
      incorrectToolName: 'transferToHuman',
      attempts: 2,
      maxAttempts: 2,
      errorName: 'ForcedToolCallError',
    })
  })
})
