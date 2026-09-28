import { vi, type Mock } from 'vitest'

import type { InactivityTimer } from './inactivity'
import type { VoiceEvent } from './types'

import { createInactivityTimer } from './inactivity'

const TIMEOUT_MS = 100

interface Harness {
  timer: InactivityTimer
  onTimeout: Mock<(inactivityCount: number) => void>
  /** The ids of the timeouts fired so far, in order. */
  timeoutIds: number[]
  activities: () => string[]
  setActive: (active: boolean) => void
  setTimeoutMs: (ms: number | undefined) => void
}

function setUp(): Harness {
  const events: VoiceEvent[] = []
  let active = true
  let timeoutMs: number | undefined = TIMEOUT_MS
  const onTimeout = vi.fn<(inactivityCount: number) => void>()
  const timeoutIds: number[] = []
  const timer = createInactivityTimer({
    timeoutMs: () => timeoutMs,
    isActive: () => active,
    onTimeout: (inactivityCount, timeoutId) => {
      timeoutIds.push(timeoutId)
      onTimeout(inactivityCount)
    },
    emit: (event) => events.push(event),
  })
  return {
    timer,
    onTimeout,
    timeoutIds,
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

  test('keeps the count through caller speech the agent does not answer', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    expect(call.onTimeout.mock.calls).toEqual([[0], [1], [2], [3]])
  })

  test('resets the count when the agent replies to the caller', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    // The second timeout's prompt.
    call.timer.agentReplyCreated()
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    call.timer.agentReplyCreated()
    call.timer.agentBecameActive()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(call.onTimeout.mock.calls).toEqual([[0], [1], [0]])
  })

  test('does not take a prompt after a timeout as the reply to speech before it', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    vi.advanceTimersByTime(TIMEOUT_MS)
    call.timer.agentReplyCreated()
    call.timer.agentBecameActive()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(call.onTimeout.mock.calls).toEqual([[0], [1], [2]])
  })

  test('keeps the count when the caller makes a sound between a timeout and its prompt', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    // A click before the prompt's audio is created: the prompt still answers nothing.
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    call.timer.agentReplyCreated()
    call.timer.agentBecameActive()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    expect(call.onTimeout.mock.calls).toEqual([[0], [1], [2]])
  })

  test("resets the count on the next reply to the caller when a timeout's prompt was skipped", () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    // The caller spoke before the prompt's hook ran, so the hook was skipped.
    call.timer.callerStartedSpeaking()
    call.timer.promptSkipped(call.timeoutIds[0]!)
    call.timer.callerStoppedSpeaking()
    call.timer.agentReplyCreated()
    call.timer.agentBecameActive()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(call.onTimeout.mock.calls).toEqual([[0], [0]])
  })

  test("never lets a skipped older timeout clear a newer timeout's pending prompt", () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    const [older, newer] = call.timeoutIds
    // The older timeout's hook is skipped late, after the newer timeout fired.
    call.timer.promptSkipped(older!)
    // A caller sound before the newer prompt is created: that prompt still answers nothing.
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    call.timer.agentReplyCreated()
    call.timer.agentBecameActive()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect([newer, call.onTimeout.mock.calls]).toEqual([2, [[0], [1], [2]]])
  })

  test('stop cancels a running timer', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    call.timer.stop()
    vi.advanceTimersByTime(TIMEOUT_MS * 10)
    expect(call.onTimeout).not.toHaveBeenCalled()
  })

  test('stop starts a fresh count that a later reply does not reset for speech before the stop', () => {
    const call = setUp()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    call.timer.callerStartedSpeaking()
    call.timer.callerStoppedSpeaking()
    call.timer.stop()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    call.timer.agentReplyCreated()
    call.timer.agentBecameActive()
    call.timer.agentWentIdle()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(call.onTimeout.mock.calls).toEqual([[0], [1], [0], [1], [2]])
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
