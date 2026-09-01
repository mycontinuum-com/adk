import { mkdirSync, createWriteStream } from 'node:fs'
import { open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { RecordingConfig, EgressRecordingConfig } from './types'

export interface RecordingSession {
  stop(): Promise<void>
}

export async function startRecordingSession(
  room: any,
  config: RecordingConfig,
  sessionId: string,
  recordingKey?: string,
): Promise<RecordingSession> {
  const stops: Array<() => Promise<unknown>> = []

  if (config.dir) {
    stops.push(startLocalRecording(room, config.dir, sessionId))
  }

  if (config.egress) {
    const stop = await startEgressRecording(room, config.egress, sessionId, recordingKey)
    if (stop) stops.push(stop)
  }

  let stopped = false
  return {
    async stop() {
      if (stopped) return
      stopped = true
      await Promise.all(stops.map((fn) => fn().catch(() => {})))
    },
  }
}

// ---------------------------------------------------------------------------
// Local recording — per-track streaming to temp files, mixed on stop
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 48_000
const CHANNELS = 1
const BYTES_PER_SAMPLE = 2

function startLocalRecording(room: any, dir: string, sessionId: string): () => Promise<void> {
  mkdirSync(dir, { recursive: true })

  let active = true
  let trackIndex = 0
  const cleanups: Array<() => void> = []
  const trackPaths: string[] = []
  const trackStreams: ReturnType<typeof createWriteStream>[] = []

  const captureTrack = (track: any) => {
    let rtc: any
    try {
      rtc = require('@livekit/rtc-node')
    } catch {
      console.warn('[adk/voice] Local recording requires @livekit/rtc-node. Audio capture skipped.')
      return
    }

    const path = join(dir, `.${sanitize(sessionId)}_track${trackIndex++}.raw`)
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

  // Track SIDs already captured to prevent double-capture during the
  // window between listener registration and existing-track enumeration.
  const capturedSids = new Set<string>()
  const captureOnce = (track: any, pub?: any) => {
    if (pub && !isAudioPub(pub)) return
    const sid = track.sid as string | undefined
    if (sid) {
      if (capturedSids.has(sid)) return
      capturedSids.add(sid)
    }
    captureTrack(track)
  }

  // Register listeners FIRST to avoid missing tracks that publish
  // between enumeration and listener registration.
  const onTrackSubscribed = (track: any, pub: any) => captureOnce(track, pub)
  room.on('trackSubscribed', onTrackSubscribed)
  cleanups.push(() => room.off('trackSubscribed', onTrackSubscribed))

  const lp = room.localParticipant
  if (lp) {
    const onLocalPub = (pub: any) => {
      if (pub.track) captureOnce(pub.track, pub)
    }
    lp.on('localTrackPublished', onLocalPub)
    cleanups.push(() => lp.off('localTrackPublished', onLocalPub))
  }

  // Now enumerate existing tracks — duplicates are filtered by capturedSids.
  const remoteParticipants: Map<string, any> | undefined = room.remoteParticipants
  if (remoteParticipants) {
    for (const [, p] of remoteParticipants) {
      for (const [, pub] of p.trackPublications ?? new Map()) {
        if (pub.track && isAudioPub(pub)) captureOnce(pub.track)
      }
    }
  }

  if (lp) {
    for (const [, pub] of lp.trackPublications ?? new Map()) {
      if (pub.track && isAudioPub(pub)) captureOnce(pub.track)
    }
  }

  return async () => {
    active = false
    for (const fn of cleanups) fn()
    cleanups.length = 0

    await Promise.all(trackStreams.map((s) => new Promise<void>((resolve) => s.end(resolve))))

    if (trackPaths.length === 0) return

    const outputPath = join(dir, `${sanitize(sessionId)}.wav`)
    await mixAndWrite(trackPaths, outputPath)

    await Promise.all(trackPaths.map((p) => unlink(p).catch(() => {})))
  }
}

// ---------------------------------------------------------------------------
// PCM mixing — stream temp files in chunks, sum samples with int16 clamping
// ---------------------------------------------------------------------------

/** Process ≈0.3 s of audio per chunk — keeps resident memory ≈128 KB. */
const MIX_CHUNK = 64 * 1024

/** @internal Exported for testing only. */
export async function mixAndWrite(paths: string[], outputPath: string): Promise<void> {
  const sizes = await Promise.all(paths.map((p) => stat(p).then((s) => s.size)))
  const maxLen = Math.max(...sizes)
  if (maxLen === 0) return

  const outFh = await open(outputPath, 'w')
  try {
    await outFh.write(wavHeader(maxLen))

    if (paths.length === 1) {
      await streamCopy(paths[0], outFh)
    } else {
      await streamMix(paths, sizes, maxLen, outFh)
    }
  } finally {
    await outFh.close()
  }
}

/** Single-track fast path — no mixing, just stream-copy raw PCM. */
async function streamCopy(
  srcPath: string,
  outFh: import('node:fs/promises').FileHandle,
): Promise<void> {
  const srcFh = await open(srcPath, 'r')
  try {
    const buf = Buffer.alloc(MIX_CHUNK)
    let result: { bytesRead: number }
    while ((result = await srcFh.read(buf, 0, MIX_CHUNK, null)).bytesRead > 0) {
      await outFh.write(buf, 0, result.bytesRead)
    }
  } finally {
    await srcFh.close()
  }
}

/** Multi-track mixing — read a chunk from each track, sum int16 samples, write. */
async function streamMix(
  paths: string[],
  sizes: number[],
  maxLen: number,
  outFh: import('node:fs/promises').FileHandle,
): Promise<void> {
  const fhs = await Promise.all(paths.map((p) => open(p, 'r')))
  try {
    const readBuf = Buffer.alloc(MIX_CHUNK)
    const mixBuf = Buffer.alloc(MIX_CHUNK)
    let offset = 0

    while (offset < maxLen) {
      const chunkBytes = Math.min(MIX_CHUNK, maxLen - offset)
      mixBuf.fill(0, 0, chunkBytes)

      for (let t = 0; t < fhs.length; t++) {
        const readable = offset < sizes[t] ? Math.min(chunkBytes, sizes[t] - offset) : 0
        if (readable === 0) continue

        await fhs[t].read(readBuf, 0, readable, null)
        const readSamples = Math.floor(readable / BYTES_PER_SAMPLE)

        for (let i = 0; i < readSamples; i++) {
          const byteOff = i * BYTES_PER_SAMPLE
          const sum = mixBuf.readInt16LE(byteOff) + readBuf.readInt16LE(byteOff)
          mixBuf.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), byteOff)
        }
      }

      await outFh.write(mixBuf, 0, chunkBytes)
      offset += chunkBytes
    }
  } finally {
    await Promise.all(fhs.map((fh) => fh.close().catch(() => {})))
  }
}

// ---------------------------------------------------------------------------
// Egress recording — LiveKit RoomCompositeEgress → S3
// ---------------------------------------------------------------------------

async function startEgressRecording(
  room: any,
  config: EgressRecordingConfig,
  sessionId: string,
  recordingKey?: string,
): Promise<(() => Promise<void>) | undefined> {
  let sdk: any
  try {
    sdk = require('livekit-server-sdk')
  } catch {
    console.error(
      '[adk/voice] Egress recording requires livekit-server-sdk. ' +
        'Install it with: npm install livekit-server-sdk',
    )
    return undefined
  }

  const roomName: string | undefined = room.name
  if (!roomName) {
    console.error('[adk/voice] Egress recording: room name not available.')
    return undefined
  }

  const livekitUrl = config.livekitUrl ?? process.env.LIVEKIT_URL
  const apiKey = config.apiKey ?? process.env.LIVEKIT_API_KEY
  const apiSecret = config.apiSecret ?? process.env.LIVEKIT_API_SECRET
  if (!livekitUrl || !apiKey || !apiSecret) {
    console.error(
      '[adk/voice] Egress recording requires LiveKit credentials. ' +
        'Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET env vars or pass them in config.',
    )
    return undefined
  }

  const awsAccessKey = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID
  const awsSecretKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY
  const awsRegion = config.region ?? process.env.AWS_REGION
  if (!awsAccessKey || !awsSecretKey) {
    console.error(
      '[adk/voice] Egress recording requires AWS credentials. ' +
        'Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY env vars or pass them in config.',
    )
    return undefined
  }

  const filepath =
    recordingKey ??
    (config.prefix
      ? `${config.prefix.replace(/\/$/, '')}/${sanitize(sessionId)}.ogg`
      : `${sanitize(sessionId)}.ogg`)

  try {
    const egressClient = new sdk.EgressClient(livekitUrl, apiKey, apiSecret)

    const egressInfo = await egressClient.startRoomCompositeEgress(
      roomName,
      new sdk.EncodedFileOutput({
        fileType: sdk.EncodedFileType.OGG,
        filepath,
        disableManifest: true,
        output: {
          case: 's3',
          value: new sdk.S3Upload({
            bucket: config.bucket,
            region: awsRegion,
            accessKey: awsAccessKey,
            secret: awsSecretKey,
          }),
        },
      }),
      { audioOnly: true },
    )

    const egressId: string = egressInfo.egressId

    return async () => {
      try {
        await egressClient.stopEgress(egressId)
      } catch {
        /* already stopped */
      }
    }
  } catch (err) {
    console.error('[adk/voice] Failed to start egress recording:', err)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** @internal Exported for testing only. */
export function isAudioPub(pub: any): boolean {
  const kind = pub.kind ?? pub.track?.kind
  return kind === 'AUDIO' || kind === 1
}

/** @internal Exported for testing only. */
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** @internal Exported for testing only. */
export function wavHeader(dataSize: number): Buffer {
  const buf = Buffer.alloc(44)
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE

  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(CHANNELS, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32)
  buf.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  return buf
}
