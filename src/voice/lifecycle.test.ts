import { vi } from 'vitest'

import type { LifecycleStateMachine, VoiceEndReason } from './lifecycle'

import { createLifecycle } from './lifecycle'

describe('LifecycleStateMachine', () => {
  let sm: LifecycleStateMachine

  beforeEach(() => {
    sm = createLifecycle()
  })

  test('starts in idle state', () => {
    expect(sm.state).toBe('idle')
    expect(sm.endReason).toBe('completed')
  })

  test('activate transitions from idle to active', () => {
    sm.activate()
    expect(sm.state).toBe('active')
  })

  test('activate is a no-op from non-idle states', () => {
    sm.activate()
    sm.tryEnd('completed')
    sm.activate()
    expect(sm.state).toBe('ending')
  })

  test('tryEnd transitions from active to ending', () => {
    sm.activate()
    const result = sm.tryEnd('completed')
    expect(result).toBe(true)
    expect(sm.state).toBe('ending')
    expect(sm.endReason).toBe('completed')
  })

  test('tryEnd returns false from idle', () => {
    const result = sm.tryEnd('completed')
    expect(result).toBe(false)
    expect(sm.state).toBe('idle')
  })

  test('tryEnd returns false from ending (first-caller-wins)', () => {
    sm.activate()
    sm.tryEnd('completed')
    const result = sm.tryEnd('disconnected')
    expect(result).toBe(false)
    expect(sm.endReason).toBe('completed')
  })

  test('tryEnd returns false from ended', () => {
    sm.activate()
    sm.tryEnd('completed')
    sm.markEnded()
    const result = sm.tryEnd('disconnected')
    expect(result).toBe(false)
    expect(sm.endReason).toBe('completed')
  })

  test('concurrent tryEnd calls — only first succeeds', () => {
    sm.activate()
    const reasons: VoiceEndReason[] = [
      'completed',
      'disconnected',
      'inactivity_timeout',
      'max_duration',
    ]
    const results = reasons.map((r) => sm.tryEnd(r))
    expect(results).toEqual([true, false, false, false])
    expect(sm.endReason).toBe('completed')
  })

  test('markEnded transitions from ending to ended', () => {
    sm.activate()
    sm.tryEnd('completed')
    sm.markEnded()
    expect(sm.state).toBe('ended')
  })

  test('markEnded is a no-op from non-ending states', () => {
    sm.activate()
    sm.markEnded()
    expect(sm.state).toBe('active')
  })

  test('onEnding callback fires when tryEnd succeeds', () => {
    const cb = vi.fn<(...args: unknown[]) => unknown>()
    sm.onEnding(cb)
    sm.activate()
    sm.tryEnd('inactivity_timeout')
    expect(cb).toHaveBeenCalledWith('inactivity_timeout')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('onEnding callback does not fire on failed tryEnd', () => {
    const cb = vi.fn<(...args: unknown[]) => unknown>()
    sm.onEnding(cb)
    sm.tryEnd('completed')
    expect(cb).not.toHaveBeenCalled()
  })

  test('onEnded callback fires when markEnded is called', () => {
    const cb = vi.fn<(...args: unknown[]) => unknown>()
    sm.onEnded(cb)
    sm.activate()
    sm.tryEnd('completed')
    sm.markEnded()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('preserves end reason through full lifecycle', () => {
    sm.activate()
    sm.tryEnd('max_duration')
    sm.markEnded()
    expect(sm.endReason).toBe('max_duration')
  })

  test('preserves end reason for transferred', () => {
    sm.activate()
    sm.tryEnd('transferred')
    expect(sm.endReason).toBe('transferred')
  })
})
