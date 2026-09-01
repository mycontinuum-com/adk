import type { VoiceTiming, TimingEntry } from './types'

// ---------------------------------------------------------------------------
// Mutable timing — accumulated during the conversation
// ---------------------------------------------------------------------------

interface MutableVoiceTiming {
  mediaReadyMs: number
  timeToFirstSpeechMs?: number
  responseTimes: TimingEntry[]
  silenceGaps: TimingEntry[]
  interruptions: { count: number; byAgent: number; byUser: number }
  vadEventTimestamps: number[]
}

// ---------------------------------------------------------------------------
// Speaker state
// ---------------------------------------------------------------------------

interface SpeakerState {
  agentSpeaking: boolean
  userSpeaking: boolean
  lastTransitionMs: number
  turnIndex: number
  /**
   * Who was the last sole speaker before silence? Used to detect response times across silence gaps
   * (LiveKit always has a gap between speaker transitions).
   */
  lastSoleSpeaker: 'agent' | 'user' | null
  lastSoleSpeakerEndMs: number
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SpeakerTracker {
  /** Call when both agent and user audio tracks are subscribed. */
  setMediaReady(): void
  /** Feed each ActiveSpeakersChanged event. */
  onActiveSpeakersChanged(speakerIdentities: string[]): void
  /** Produce the final VoiceTiming snapshot. */
  finalize(): VoiceTiming
}

export function createSpeakerTracker(agentIdentity: string, userIdentity: string): SpeakerTracker {
  const now = Date.now()

  const state: SpeakerState = {
    agentSpeaking: false,
    userSpeaking: false,
    lastTransitionMs: now,
    turnIndex: 0,
    lastSoleSpeaker: null,
    lastSoleSpeakerEndMs: now,
  }

  const timing: MutableVoiceTiming = {
    mediaReadyMs: now,
    responseTimes: [],
    silenceGaps: [],
    interruptions: { count: 0, byAgent: 0, byUser: 0 },
    vadEventTimestamps: [],
  }

  return {
    setMediaReady() {
      const ms = Date.now()
      timing.mediaReadyMs = ms
      state.lastTransitionMs = ms
    },

    onActiveSpeakersChanged(speakerIdentities: string[]) {
      const nowMs = Date.now()
      timing.vadEventTimestamps.push(nowMs)

      const elapsed = nowMs - state.lastTransitionMs

      const prev = { agent: state.agentSpeaking, user: state.userSpeaking }
      const next = {
        agent: speakerIdentities.includes(agentIdentity),
        user: speakerIdentities.includes(userIdentity),
      }

      // No change — ignore
      if (prev.agent === next.agent && prev.user === next.user) return

      // --- Silence gap: both were silent, someone starts ---
      if (!prev.agent && !prev.user && (next.agent || next.user)) {
        timing.silenceGaps.push({ ms: elapsed, afterTurnIndex: state.turnIndex })

        // Response time across silence gap: last sole speaker was X, now Y starts.
        // LiveKit almost always has a silence gap between speakers, so the direct
        // "user speaking → agent starts" transition rarely fires. Instead we measure
        // from when the last sole speaker stopped to when the new speaker begins.
        const nextSole =
          next.agent && !next.user ? 'agent' : next.user && !next.agent ? 'user' : null
        if (nextSole && state.lastSoleSpeaker && nextSole !== state.lastSoleSpeaker) {
          const responseMs = nowMs - state.lastSoleSpeakerEndMs
          timing.responseTimes.push({
            ms: responseMs,
            afterTurnIndex: state.turnIndex,
            speaker: nextSole,
          })
        }
      }

      // --- Response time: user was speaking alone, agent starts (direct, no gap) ---
      if (prev.user && !prev.agent && next.agent) {
        timing.responseTimes.push({
          ms: elapsed,
          afterTurnIndex: state.turnIndex,
          speaker: 'agent',
        })
        if (next.user) {
          timing.interruptions.byAgent++
          timing.interruptions.count++
        }
      }

      // --- Interruption: agent was speaking alone, user starts while agent continues ---
      if (prev.agent && !prev.user && next.user) {
        if (next.agent) {
          timing.interruptions.byUser++
          timing.interruptions.count++
        }
      }

      // --- Simultaneous start from silence (both start in same VAD tick) ---
      if (!prev.agent && !prev.user && next.agent && next.user) {
        timing.interruptions.count++
        // Not attributed to either side
      }

      // --- First speech by agent ---
      if (timing.timeToFirstSpeechMs == null && next.agent) {
        timing.timeToFirstSpeechMs = nowMs - timing.mediaReadyMs
      }

      // --- Turn index: increment on sole-speaker role change ---
      const prevSole = prev.agent && !prev.user ? 'agent' : prev.user && !prev.agent ? 'user' : null
      const nextSole = next.agent && !next.user ? 'agent' : next.user && !next.agent ? 'user' : null
      if (prevSole && nextSole && prevSole !== nextSole) {
        state.turnIndex++
      }

      // Track last sole speaker — when a sole speaker transitions to silence,
      // record who they were and when they stopped for cross-gap response time.
      if (prevSole && !nextSole) {
        state.lastSoleSpeaker = prevSole
        state.lastSoleSpeakerEndMs = nowMs
      }

      state.agentSpeaking = next.agent
      state.userSpeaking = next.user
      state.lastTransitionMs = nowMs
    },

    finalize(): VoiceTiming {
      const deltas: number[] = []
      for (let i = 1; i < timing.vadEventTimestamps.length; i++) {
        deltas.push(timing.vadEventTimestamps[i] - timing.vadEventTimestamps[i - 1])
      }
      const vadResolutionMs =
        deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0

      return {
        timeToFirstSpeechMs: timing.timeToFirstSpeechMs,
        responseTimes: [...timing.responseTimes],
        silenceGaps: [...timing.silenceGaps],
        interruptions: { ...timing.interruptions },
        vadResolutionMs,
      }
    },
  }
}
