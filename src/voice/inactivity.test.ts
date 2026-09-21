import { vi, type Mock } from 'vitest'

import type { VoiceEvent } from './types'

import type { InactivityTimer } from './inactivity'

import { createInactivityTimer } from './inactivity'

const TIMEOUT_MS = 100

interface Harness {
  timer: InactivityTimer
  onTimeout: Mock<(inactivityCount: number) => void>
  activities: () => string[]
  setActive: (active: boolean) => void
  setTimeoutMs: (ms: number | undefined) => void
}

function setUp(): Harness {
  const events: VoiceEvent[] = []
  let active = true
  let timeoutMs: number | undefined = TIMEOUT_MS
  const onTimeout = vi.fn<(inactivityCount: number) => void>()
  const timer = createInactivityTimer({
    timeoutMs: () => timeoutMs,
    isActive: () => active,
    onTimeout,
    emit: (event) => events.push(event),
  })
  return {
    timer,
    onTimeout,
    activities: () =>
      events.flatMap((event) => (event.type === 'voice_activity' ? [event.activity] : [])),
    setActive: (value) => (active = value),
    setTimeoutMs: (value) => (timeoutMs = value),
  }
}

describe('createInactivityTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('fires after the timeout once the agent goes idle', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS - 1)
    expect(call.onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(call.onTimeout).toHaveBeenCalledWith(0)
  })

  test('does not count the caller talking over the agent as silence', () => {
    const call = setUp()
    call.timer.callerStartedSpeaking()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 10)
    expect(call.onTimeout).not.toHaveBeenCalled()
  })

  test('counts the timeout from when the caller stops speaking', () => {
    const call = setUp()
    call.timer.callerStartedSpeaking()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 5)
    call.timer.callerStoppedSpeaking()
    vi.advanceTimersByTime(TIMEOUT_MS - 1)
    expect(call.onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(call.onTimeout).toHaveBeenCalledTimes(1)
    expect(call.activities()).toEqual([
      'inactivity_timer_started',
      'inactivity_timeout_fired',
      'inactivity_timer_cleared',
      'inactivity_timer_started',
    ])
  })

  test('waits for the agent when the caller stops while the agent is active', () => {
    const call = setUp()
    call.timer.agentBecameActive()
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    vi.advanceTimersByTime(TIMEOUT_MS * 10)
    expect(call.onTimeout).not.toHaveBeenCalled()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(call.onTimeout).toHaveBeenCalledTimes(1)
  })

  test('gives a newly created reply a fresh timeout', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS - 20)
    call.timer.agentReplyCreated()
    vi.advanceTimersByTime(TIMEOUT_MS - 20)
    expect(call.onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(call.onTimeout).toHaveBeenCalledTimes(1)
  })

  test('does not start a stopped timer when a reply is created', () => {
    const call = setUp()
    call.timer.agentReplyCreated()
    vi.advanceTimersByTime(TIMEOUT_MS * 10)
    expect(call.onTimeout).not.toHaveBeenCalled()
  })

  test('counts consecutive timeouts and resets the count when the caller speaks', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(call.onTimeout.mock.calls).toEqual([[0], [1], [0]])
  })

  test('stop cancels a running timer', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    call.timer.stop()
    vi.advanceTimersByTime(TIMEOUT_MS * 10)
    expect(call.onTimeout).not.toHaveBeenCalled()
  })

  test('does not fire once the session is no longer active', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    call.setActive(false)
    vi.advanceTimersByTime(TIMEOUT_MS * 10)
    expect(call.onTimeout).not.toHaveBeenCalled()
  })

  test('reads the timeout at every start, and an unset timeout disables it', () => {
    const call = setUp()
    call.setTimeoutMs(undefined)
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 10)
    expect(call.onTimeout).not.toHaveBeenCalled()

    call.setTimeoutMs(TIMEOUT_MS * 2)
    call.timer.agentBecameActive()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2 - 1)
    expect(call.onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(call.onTimeout).toHaveBeenCalledTimes(1)
  })
})
