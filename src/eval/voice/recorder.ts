import type {
  Room,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
} from '@livekit/rtc-node' with { 'resolution-mode': 'import' }

import { mkdirSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'

import { mixAndWrite, isAudioPub, sanitize } from '../../voice/recording'
import { createSpeakerTracker, type SpeakerTracker } from './speaker-tracker'

export interface RecordingHandle {
  tracker: SpeakerTracker
  /** Resolves when both agent and user audio tracks are subscribed. */
  mediaReady: Promise<void>
  /** Stop recording and write WAV file. Returns the file path. */
  stop(): Promise<string>
}

export interface RecorderHandle extends RecordingHandle {
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

type RecordingRoom = Pick<Room, 'on' | 'off' | 'remoteParticipants'>
type RecordingConfig = Pick<
  RecorderConfig,
  'agentIdentity' | 'userIdentity' | 'recordingDir' | 'caseName'
>
type RecorderSDK = Pick<
  typeof import('@livekit/rtc-node', { with: { 'resolution-mode': 'import' } }),
  'Room' | 'AudioStream'
>

function loadSDK(): RecorderSDK {
  try {
    return require('@livekit/rtc-node')
  } catch {
    throw new Error(
      '[adk/voice-eval] @livekit/rtc-node is required for voice evaluation. Install it with: npm install @livekit/rtc-node',
    )
  }
}

/** Record remote audio already subscribed by these rooms; their owner controls connection lifetime. */
export function recordRooms(
  config: RecordingConfig & { rooms: readonly RecordingRoom[] },
  sdk: Pick<RecorderSDK, 'AudioStream'> = loadSDK(),
): RecordingHandle {
  mkdirSync(config.recordingDir, { recursive: true })
  const tracker = createSpeakerTracker(config.agentIdentity, config.userIdentity)
  const ready = new Set<string>()
  let resolveMediaReady!: () => void
  const mediaReady = new Promise<void>((resolve) => {
    resolveMediaReady = resolve
  })
  let active = true
  let stopping: Promise<string> | undefined
  const trackPaths: string[] = []
  const trackStreams: ReturnType<typeof createWriteStream>[] = []
  const cleanups: Array<() => void | Promise<void>> = []
  const captured = new Set<string | RemoteTrack>()

  const subscribe = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (!active || !isAudioPub(publication)) return
    const identity = participant.identity
    if (identity !== config.agentIdentity && identity !== config.userIdentity) return
    const sid = publication.sid ?? track.sid ?? track
    if (captured.has(sid)) return
    captured.add(sid)
    ready.add(identity)
    if (ready.size === 2) {
      tracker.setMediaReady()
      resolveMediaReady()
    }
    const path = join(
      config.recordingDir,
      `.${sanitize(config.caseName)}_track${trackPaths.length}.raw`,
    )
    const stream = createWriteStream(path)
    trackPaths.push(path)
    trackStreams.push(stream)
    const reader = new sdk.AudioStream(track, 48_000, 1).getReader()
    void (async () => {
      try {
        while (active) {
          const frame = await reader.read()
          if (frame.done || !active) break
          const pcm = frame.value.data
          stream.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        }
      } catch {
        /* Audio tracks can close before recording stops. */
      }
    })()
    cleanups.push(() => reader.cancel())
  }
  for (const room of config.rooms) {
    room.on('trackSubscribed', subscribe)
    cleanups.push(() => {
      room.off('trackSubscribed', subscribe)
    })
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) subscribe(publication.track, publication, participant)
      }
    }
  }
  const timingRoom = config.rooms[0]
  const speakers = (participants: Array<{ identity: string }>) => {
    tracker.onActiveSpeakersChanged(participants.map((participant) => participant.identity))
  }
  timingRoom?.on('activeSpeakersChanged', speakers)
  cleanups.push(() => {
    timingRoom?.off('activeSpeakersChanged', speakers)
  })

  return {
    tracker,
    mediaReady,
    stop() {
      return (stopping ??= (async () => {
        active = false
        for (const cleanup of cleanups.splice(0)) await cleanup()
        await Promise.all(
          trackStreams.map((stream) => new Promise<void>((resolve) => stream.end(resolve))),
        )
        if (trackPaths.length === 0)
          throw new Error(
            'Voice eval recording received no audio tracks. Check participant audio publication and recorder subscriptions.',
          )
        const outputPath = join(config.recordingDir, 'recording.wav')
        await mixAndWrite(trackPaths, outputPath)
        const { unlink } = await import('node:fs/promises')
        await Promise.all(trackPaths.map((path) => unlink(path).catch(() => {})))
        return outputPath
      })())
    },
  }
}

/**
 * Joins `config.roomUrl` as a separate participant and records the room's remote audio.
 *
 * @returns The recording handle plus `disconnect()`, which leaves the room.
 */
export async function connectRecorder(
  config: RecorderConfig,
  sdk = loadSDK(),
): Promise<RecorderHandle> {
  const room = new sdk.Room()
  await room.connect(config.roomUrl, config.token, { autoSubscribe: true, dynacast: false })
  const recording = recordRooms({ ...config, rooms: [room] }, sdk)
  return { ...recording, disconnect: () => room.disconnect() }
}
