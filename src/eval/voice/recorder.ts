import { mkdirSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'

import { mixAndWrite, isAudioPub, sanitize } from '../../voice/recording'
import { createSpeakerTracker, type SpeakerTracker } from './speaker-tracker'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RecorderHandle {
  tracker: SpeakerTracker
  /** Resolves when both agent and user audio tracks are subscribed. */
  mediaReady: Promise<void>
  /** Stop recording and write WAV file. Returns the file path. */
  stop(): Promise<string>
  /** Disconnect the recorder participant from the room. */
  disconnect(): Promise<void>
}

export interface RecorderConfig {
  roomUrl: string
  token: string
  agentIdentity: string
  userIdentity: string
  recordingDir: string
  caseName: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 48_000
const CHANNELS = 1

export async function connectRecorder(config: RecorderConfig): Promise<RecorderHandle> {
  let rtc: any
  try {
    rtc = require('@livekit/rtc-node')
  } catch {
    throw new Error(
      '[adk/voice-eval] @livekit/rtc-node is required for voice evaluation. ' +
        'Install it with: npm install @livekit/rtc-node',
    )
  }

  mkdirSync(config.recordingDir, { recursive: true })

  const room = new rtc.Room()
  await room.connect(config.roomUrl, config.token, { autoSubscribe: true })

  const tracker = createSpeakerTracker(config.agentIdentity, config.userIdentity)

  // --- Media readiness tracking ---
  let agentTrackReady = false
  let userTrackReady = false
  let resolveMediaReady!: () => void
  const mediaReady = new Promise<void>((r) => {
    resolveMediaReady = r
  })

  // --- Audio capture state ---
  let active = true
  let trackIndex = 0
  const trackPaths: string[] = []
  const trackStreams: ReturnType<typeof createWriteStream>[] = []
  const cleanups: Array<() => void> = []
  const capturedSids = new Set<string>()

  const captureTrack = (track: any) => {
    const path = join(config.recordingDir, `.${sanitize(config.caseName)}_track${trackIndex++}.raw`)
    const stream = createWriteStream(path)
    trackPaths.push(path)
    trackStreams.push(stream)

    const audioStream = new rtc.AudioStream(track, SAMPLE_RATE, CHANNELS)
    const pump = async () => {
      try {
        for await (const frame of audioStream) {
          if (!active) break
          const pcm = frame.data
          if (pcm?.buffer) {
            stream.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
          }
        }
      } catch {
        /* stream closed or track ended */
      }
    }
    pump()
    cleanups.push(() => {
      try {
        audioStream.close?.()
      } catch {
        /* ignore */
      }
    })
  }

  const captureOnce = (track: any, pub?: any) => {
    if (pub && !isAudioPub(pub)) return
    const sid = track.sid as string | undefined
    if (sid) {
      if (capturedSids.has(sid)) return
      capturedSids.add(sid)
    }
    captureTrack(track)
  }

  // --- Room event wiring ---

  const debug = !!process.env.ADK_VOICE_EVAL_DEBUG

  room.on('trackSubscribed', (track: any, pub: any, participant: any) => {
    const isAudio = isAudioPub(pub)
    const identity = participant.identity as string
    if (debug) {
      console.log(`[voice-eval:recorder] trackSubscribed: ${identity} audio=${isAudio}`)
    }
    if (!isAudio) return
    captureOnce(track, pub)

    if (identity === config.agentIdentity) agentTrackReady = true
    if (identity === config.userIdentity) userTrackReady = true

    if (agentTrackReady && userTrackReady) {
      if (debug) console.log('[voice-eval:recorder] mediaReady — both tracks subscribed')
      tracker.setMediaReady()
      resolveMediaReady()
    }
  })

  room.on('activeSpeakersChanged', (speakers: any[]) => {
    const identities = speakers.map((s: any) => s.identity as string)
    if (debug) {
      console.log(`[voice-eval:recorder] activeSpeakers: [${identities.join(', ')}]`)
    }
    tracker.onActiveSpeakersChanged(identities)
  })

  return {
    tracker,
    mediaReady,

    async stop(): Promise<string> {
      active = false
      for (const fn of cleanups) fn()
      cleanups.length = 0

      await Promise.all(trackStreams.map((s) => new Promise<void>((resolve) => s.end(resolve))))

      const outputPath = join(config.recordingDir, 'recording.wav')

      if (trackPaths.length > 0) {
        await mixAndWrite(trackPaths, outputPath)
        // Clean up temp raw files
        const { unlink } = await import('node:fs/promises')
        await Promise.all(trackPaths.map((p) => unlink(p).catch(() => {})))
      }

      return outputPath
    },

    async disconnect() {
      await room.disconnect()
    },
  }
}
