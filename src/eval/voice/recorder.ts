import { mkdirSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'

import { mixAndWrite, isAudioPub, sanitize } from '../../voice/recording'
import { createSpeakerTracker, type SpeakerTracker } from './speaker-tracker'

export interface RecordingHandle {
  tracker: SpeakerTracker
  /** Stop recording and write WAV file. Returns the file path. */
  stop(): Promise<string>
}

interface RecordedParticipant {
  readonly identity: string
}

interface RecordedPublication<Track> {
  readonly sid?: string
  /** Audio is `1` or `'AUDIO'`, on the publication or its track. */
  readonly kind?: unknown
  readonly track?: Track
}

type TrackSubscribed<Track> = (
  track: Track,
  publication: RecordedPublication<Track>,
  participant: RecordedParticipant,
) => void
type ActiveSpeakersChanged = (speakers: RecordedParticipant[]) => void

/** What the recorder reads of a room; a connected `@livekit/rtc-node` `Room` is one. */
export interface RecordingRoom<Track> {
  on(event: 'trackSubscribed', listener: TrackSubscribed<Track>): unknown
  on(event: 'activeSpeakersChanged', listener: ActiveSpeakersChanged): unknown
  off(event: 'trackSubscribed', listener: TrackSubscribed<Track>): unknown
  off(event: 'activeSpeakersChanged', listener: ActiveSpeakersChanged): unknown
  readonly remoteParticipants: ReadonlyMap<
    string,
    RecordedParticipant & {
      readonly trackPublications: ReadonlyMap<string, RecordedPublication<Track>>
    }
  >
}

/** The audio reader the recorder uses: `@livekit/rtc-node`'s `AudioStream`. */
export interface RecordingSdk<Track> {
  AudioStream: new (
    track: Track,
    sampleRate: number,
    numChannels: number,
  ) => ReadableStream<{ readonly data: Int16Array }>
}
interface RecordingConfig {
  agentIdentity: string
  userIdentity: string
  recordingDir: string
  caseName: string
}

/**
 * Records remote audio already subscribed by these rooms; their owner controls connection lifetime.
 * Pass the call's own participant rooms: a separate subscribe-only participant is not reliably
 * subscribed (on rtc-node 0.13.34 LiveKit left about a third of such recorders with no tracks).
 */
export function recordRooms<Track extends { readonly sid?: string }>(
  config: RecordingConfig & { rooms: readonly RecordingRoom<Track>[] },
  sdk: RecordingSdk<Track>,
): RecordingHandle {
  mkdirSync(config.recordingDir, { recursive: true })
  const tracker = createSpeakerTracker(config.agentIdentity, config.userIdentity)
  const ready = new Set<string>()
  let active = true
  let stopping: Promise<string> | undefined
  const trackPaths: string[] = []
  const trackStreams: ReturnType<typeof createWriteStream>[] = []
  const cleanups: Array<() => void | Promise<void>> = []
  const captured = new Set<string | Track>()

  const subscribe: TrackSubscribed<Track> = (track, publication, participant) => {
    if (!active || !isAudioPub(publication)) return
    const identity = participant.identity
    if (identity !== config.agentIdentity && identity !== config.userIdentity) return
    const sid = publication.sid ?? track.sid ?? track
    if (captured.has(sid)) return
    captured.add(sid)
    ready.add(identity)
    if (ready.size === 2) tracker.setMediaReady()
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
  const speakers: ActiveSpeakersChanged = (participants) => {
    tracker.onActiveSpeakersChanged(participants.map((participant) => participant.identity))
  }
  timingRoom?.on('activeSpeakersChanged', speakers)
  cleanups.push(() => {
    timingRoom?.off('activeSpeakersChanged', speakers)
  })

  return {
    tracker,
    stop() {
      return (stopping ??= (async () => {
        active = false
        await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
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
