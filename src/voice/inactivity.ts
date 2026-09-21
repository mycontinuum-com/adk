import type { VoiceEvent } from './types'

export interface InactivityTimerOptions {
  /** Read at every start, so an agent transfer can change it. Unset disables the timer. */
  timeoutMs: () => number | undefined
  isActive: () => boolean
  /** Receives how many timeouts have fired in a row before this one. */
  onTimeout: (inactivityCount: number) => void
  emit: (event: VoiceEvent) => void
}

export interface InactivityTimer {
  callerStartedSpeaking(): void
  callerStoppedSpeaking(): void
  agentBecameActive(): void
  agentWentIdle(): void
  /**
   * A reply is on its way, so a prompt now would cut it off. The timer restarts rather than
   * stops, so a reply that never plays still ends in a prompt.
   */
  agentReplyCreated(): void
  /** Cancels the timer and the count without reporting it, for a transfer or session end. */
  stop(): void
}

/**
 * Fires `onTimeout` after a stretch of silence, meaning neither the caller nor the agent is
 * speaking.
 *
 * A caller who talks over the agent is already speaking when the agent goes idle, so the
 * timer waits for them to finish. Agent `thinking` counts as active, because it covers tool
 * calls that can run far longer than the timeout.
 */
export function createInactivityTimer(options: InactivityTimerOptions): InactivityTimer {
  let handle: ReturnType<typeof setTimeout> | undefined
  let inactivityCount = 0
  let userSpeaking = false
  let agentActive = false

  const clear = (reason: string) => {
    if (!handle) return
    clearTimeout(handle)
    handle = undefined
    options.emit({ type: 'voice_activity', activity: 'inactivity_timer_cleared', reason })
  }

  const start = () => {
    clear('restart')
    const timeoutMs = options.timeoutMs()
    if (!timeoutMs || !options.isActive()) return
    options.emit({
      type: 'voice_activity',
      activity: 'inactivity_timer_started',
      inactivityCount,
      timeoutMs,
    })
    handle = setTimeout(() => {
      if (!options.isActive()) return
      const count = inactivityCount++
      options.emit({
        type: 'voice_activity',
        activity: 'inactivity_timeout_fired',
        inactivityCount: count,
        timeoutMs,
      })
      options.onTimeout(count)
      start()
    }, timeoutMs)
  }

  return {
    callerStartedSpeaking() {
      userSpeaking = true
      inactivityCount = 0
      clear('user_speech_started')
    },

    callerStoppedSpeaking() {
      userSpeaking = false
      if (!agentActive) start()
    },

    agentBecameActive() {
      agentActive = true
      clear('agent_active')
    },

    agentWentIdle() {
      agentActive = false
      if (!userSpeaking) start()
    },

    agentReplyCreated() {
      if (handle) start()
    },

    stop() {
      if (handle) clearTimeout(handle)
      handle = undefined
      inactivityCount = 0
    },
  }
}
