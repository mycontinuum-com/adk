import type { VoiceEvent } from './types'

interface InactivityTimerOptions {
  /** Read at every start, so an agent transfer can change it. Unset disables the timer. */
  timeoutMs: () => number | undefined
  isActive: () => boolean
  /**
   * Receives how many timeouts have fired in a row before this one, and this timeout's own id. The
   * count resets only when the agent replies to the caller, so a noise the agent does not answer
   * keeps it.
   */
  onTimeout: (inactivityCount: number, timeoutId: number) => void
  emit: (event: VoiceEvent) => void
}

export interface InactivityTimer {
  callerStartedSpeaking(): void
  callerStoppedSpeaking(): void
  agentBecameActive(): void
  agentWentIdle(): void
  /**
   * A reply is on its way, so a prompt now would cut it off. The timer restarts rather than stops,
   * so a reply that never plays still ends in a prompt. The first reply after a timeout is taken as
   * its prompt and never resets the count. Any other reply created after the caller spoke, before
   * another timeout fired, answers the caller and resets the count.
   */
  agentReplyCreated(): void
  /**
   * The prompt of timeout `timeoutId` will not be created, because its hook was skipped. If that is
   * the timeout still awaiting its prompt, the next reply is not taken as a prompt. A skipped older
   * timeout never clears a newer one's pending prompt.
   */
  promptSkipped(timeoutId: number): void
  /**
   * Timeout `timeoutId` found caller speech the agent had not answered, so it was no silence: it is
   * not counted, and the next reply answers the caller.
   */
  callerUnanswered(timeoutId: number): void
  /** Cancels the timer and the count without reporting it, for a transfer or session end. */
  stop(): void
}

/**
 * Fires `onTimeout` after a stretch of silence, meaning neither the caller nor the agent is
 * speaking.
 *
 * A caller who talks over the agent is already speaking when the agent goes idle, so the timer
 * waits for them to finish. Agent `thinking` counts as active, because it covers tool calls that
 * can run far longer than the timeout.
 */
export function createInactivityTimer(options: InactivityTimerOptions): InactivityTimer {
  let handle: ReturnType<typeof setTimeout> | undefined
  let inactivityCount = 0
  /** The caller has spoken since the last timeout, so the agent's next reply answers them. */
  let awaitingReply = false
  /** Ids the timeouts in firing order. */
  let fired = 0
  /**
   * The timeout that fired and whose prompt has not been created yet. The next reply is that
   * prompt, so it never resets the count, even when the caller made a sound before it played.
   */
  let promptPendingFor: number | undefined
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
      awaitingReply = false
      const timeoutId = ++fired
      promptPendingFor = timeoutId
      options.emit({
        type: 'voice_activity',
        activity: 'inactivity_timeout_fired',
        inactivityCount: count,
        timeoutMs,
      })
      options.onTimeout(count, timeoutId)
      start()
    }, timeoutMs)
  }

  return {
    callerStartedSpeaking() {
      userSpeaking = true
      awaitingReply = true
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
      if (promptPendingFor !== undefined) promptPendingFor = undefined
      else {
        if (awaitingReply) inactivityCount = 0
        awaitingReply = false
      }
      if (handle) start()
    },

    promptSkipped(timeoutId) {
      if (promptPendingFor === timeoutId) promptPendingFor = undefined
    },

    callerUnanswered(timeoutId) {
      if (timeoutId !== fired) return
      if (promptPendingFor === timeoutId) promptPendingFor = undefined
      inactivityCount = Math.max(0, inactivityCount - 1)
      awaitingReply = true
    },

    stop() {
      if (handle) clearTimeout(handle)
      handle = undefined
      inactivityCount = 0
      promptPendingFor = undefined
    },
  }
}
