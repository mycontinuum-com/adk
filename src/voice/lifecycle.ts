export type LifecycleState = 'idle' | 'active' | 'ending' | 'ended'

export type VoiceEndReason =
  | 'completed'
  | 'transferred'
  | 'inactivity_timeout'
  | 'max_duration'
  | 'disconnected'
  | 'participant_left'

export interface LifecycleStateMachine {
  readonly state: LifecycleState
  readonly endReason: VoiceEndReason
  activate(): void
  tryEnd(reason: VoiceEndReason): boolean
  onEnding(cb: (reason: VoiceEndReason) => void): void
  onEnded(cb: () => void): void
  markEnded(): void
}

export function createLifecycle(): LifecycleStateMachine {
  let state: LifecycleState = 'idle'
  let endReason: VoiceEndReason = 'completed'
  const endingCallbacks: Array<(reason: VoiceEndReason) => void> = []
  const endedCallbacks: Array<() => void> = []

  return {
    get state() {
      return state
    },
    get endReason() {
      return endReason
    },

    activate() {
      if (state !== 'idle') return
      state = 'active'
    },

    tryEnd(reason: VoiceEndReason): boolean {
      if (state !== 'active') return false
      state = 'ending'
      endReason = reason
      for (const cb of endingCallbacks) cb(reason)
      return true
    },

    markEnded() {
      if (state !== 'ending') return
      state = 'ended'
      for (const cb of endedCallbacks) cb()
    },

    onEnding(cb) {
      endingCallbacks.push(cb)
    },
    onEnded(cb) {
      endedCallbacks.push(cb)
    },
  }
}
