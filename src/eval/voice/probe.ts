import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { VoiceRoomConfig } from './types'

import { createLiveKitProbe } from './probe-livekit'

export interface VoiceProbeOptions {
  agentName: string
  room?: Partial<VoiceRoomConfig>
  input: { pcm16: Int16Array; sampleRate: number }
  participantAttributes?: Record<string, string>
  initialSilenceMs?: number
  /** Observation window after dispatch, from 20 to 120,000 ms. Default: 15,000. */
  durationMs?: number
  /** Request an opaque observation from the assigned worker after the audio window. */
  observeRpc?: { method: string; payload?: string }
  /** Retain opaque UTF-8 data sent by the dispatch-assigned worker on this topic. */
  observeData?: { topic: string }
  /** End observation when the remote room disconnects. Applications still assert the reason. */
  allowRemoteDisconnect?: boolean
  /** Record non-silent sent/received frame intervals using the probe host's epoch clock. */
  observeAudioActivity?: boolean
}

export interface VoiceProbeResult {
  status: 'completed' | 'error' | 'timeout'
  agentName: string
  roomName: string
  receivedAudioMs: number
  receivedNonSilentAudioMs: number
  assistantTranscripts: string[]
  durationMs: number
  error?: string
  rpcResponse?: string
  observations?: Array<{ receivedAtMs: number; payload: string }>
  remoteDisconnect?: { atMs: number; reason: string }
  audioActivity?: {
    startedAt: number
    caller: Array<{ start: number; end: number }>
    agent: Array<{ start: number; end: number }>
  }
}

/** @internal The network boundary, also used for deterministic lifecycle tests. */
export interface VoiceProbeDriver {
  start(): Promise<void>
  dispatch(): Promise<void>
  sendFrame(pcm16: Int16Array): Promise<void>
  observeRpc(request: NonNullable<VoiceProbeOptions['observeRpc']>): Promise<string>
  close(): Promise<void>
}

/** @internal */
export interface VoiceProbeConnection {
  room: VoiceRoomConfig
  roomName: string
  agentName: string
  sampleRate: number
  participantAttributes: Record<string, string>
  signal: AbortSignal
  observeData?: VoiceProbeOptions['observeData']
  onAudio(pcm16: Int16Array, sampleRate: number): void
  onTranscript(text: string, segmentId: string): void
  onError(): void
  onData(payload: string): void
  onRemoteDisconnect(reason: string): void
}

/** Observe an explicitly dispatched worker without creating an ADK domain session. */
export function runVoiceProbe(options: VoiceProbeOptions): Promise<VoiceProbeResult> {
  return executeVoiceProbe(options, createLiveKitProbe)
}

/** @internal */
export async function executeVoiceProbe(
  options: VoiceProbeOptions,
  createDriver: (connection: VoiceProbeConnection) => Promise<VoiceProbeDriver>,
): Promise<VoiceProbeResult> {
  const durationMs = options.durationMs ?? 15_000
  const silenceMs = options.initialSilenceMs ?? 3_000
  const sampleRate = options.input.sampleRate
  const url = options.room?.url ?? process.env.LIVEKIT_URL
  if (!url || !options.agentName.trim())
    throw new Error('A LiveKit URL and named worker are required')
  if (options.observeRpc && !options.observeRpc.method.trim())
    throw new Error('An observation RPC method is required')
  if (options.observeData && !options.observeData.topic.trim())
    throw new Error('An observation data topic is required')
  if (![8000, 16000, 24000, 48000].includes(sampleRate))
    throw new Error('Unsupported PCM sample rate')
  if (
    !Number.isFinite(durationMs) ||
    durationMs < 20 ||
    durationMs > 120_000 ||
    durationMs % 20 !== 0
  ) {
    throw new Error('durationMs must be a multiple of 20 between 20 and 120,000')
  }
  if (
    !Number.isFinite(silenceMs) ||
    silenceMs < 0 ||
    silenceMs % 20 !== 0 ||
    silenceMs + (options.input.pcm16.length / sampleRate) * 1000 > durationMs
  ) {
    throw new Error('Silence and the complete PCM fixture must fit within durationMs')
  }
  return new VoiceProbeRun(options, createDriver, url, durationMs, silenceMs).execute()
}

function hasSpeech(pcm: Int16Array): boolean {
  return pcm.some((sample) => Math.abs(sample) > 32)
}

/** Appends a non-silent frame to the speaker's activity, merging gaps of 100 ms or less. */
function recordAudio(
  activity: VoiceProbeResult['audioActivity'],
  speaker: 'caller' | 'agent',
  pcm: Int16Array,
  rate: number,
): void {
  const intervals = activity?.[speaker]
  if (!intervals || !hasSpeech(pcm)) return
  const start = Date.now()
  const end = start + (pcm.length / rate) * 1000
  const previous = intervals.at(-1)
  if (previous && start - previous.end <= 100) previous.end = Math.max(previous.end, end)
  else intervals.push({ start, end })
}

/** One probe execution. `controller` aborts every phase; its reason explains why. */
class VoiceProbeRun {
  private readonly started = Date.now()
  private readonly controller = new AbortController()
  private readonly transcripts = new Map<string, string>()
  private readonly result: VoiceProbeResult
  private driver: VoiceProbeDriver | undefined
  private phase = 'connection'

  constructor(
    private readonly options: VoiceProbeOptions,
    private readonly createDriver: (connection: VoiceProbeConnection) => Promise<VoiceProbeDriver>,
    private readonly url: string,
    private readonly durationMs: number,
    private readonly silenceMs: number,
  ) {
    this.result = {
      status: 'completed',
      agentName: options.agentName,
      roomName: `voice-probe-${randomUUID()}`,
      receivedAudioMs: 0,
      receivedNonSilentAudioMs: 0,
      assistantTranscripts: [],
      durationMs: 0,
      ...(options.observeData ? { observations: [] } : {}),
    }
  }

  async execute(): Promise<VoiceProbeResult> {
    const { controller, options, result } = this
    const deadline = setTimeout(
      () => controller.abort('timeout'),
      this.durationMs + 15_000 + (options.observeRpc ? 5_000 : 0),
    )
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Probe stopped')), {
        once: true,
      })
    })
    try {
      await Promise.race([aborted, this.drive(aborted)])
    } catch {
      if (!(options.allowRemoteDisconnect && controller.signal.reason === 'remote-disconnect')) {
        result.status = controller.signal.reason === 'timeout' ? 'timeout' : 'error'
        result.error = `Voice probe ${result.status} during ${this.phase}`
      }
    } finally {
      clearTimeout(deadline)
      controller.abort('finished')
      await this.closeDriver()
      result.durationMs = Date.now() - this.started
    }
    return result
  }

  private async drive(aborted: Promise<never>): Promise<void> {
    const { controller, options, result } = this
    const sampleRate = options.input.sampleRate
    const driver = await this.createDriver(this.connection())
    this.driver = driver
    if (controller.signal.aborted) {
      await driver.close()
      return
    }
    await driver.start()
    this.phase = 'dispatch'
    await driver.dispatch()
    controller.signal.throwIfAborted()
    this.phase = 'audio'
    const audioStarted = Date.now()
    if (options.observeAudioActivity)
      result.audioActivity = { startedAt: audioStarted, caller: [], agent: [] }
    const frameSamples = sampleRate / 50
    for (let offsetMs = 0; offsetMs < this.durationMs; offsetMs += 20) {
      controller.signal.throwIfAborted()
      const pcm = new Int16Array(frameSamples)
      const fixtureOffset = ((offsetMs - this.silenceMs) * sampleRate) / 1000
      if (fixtureOffset >= 0)
        pcm.set(options.input.pcm16.subarray(fixtureOffset, fixtureOffset + frameSamples))
      await driver.sendFrame(pcm)
      recordAudio(result.audioActivity, 'caller', pcm, sampleRate)
      await delay(Math.max(0, audioStarted + offsetMs + 20 - Date.now()), undefined, {
        signal: controller.signal,
      })
    }
    if (options.observeRpc) {
      this.phase = 'observation'
      const observationDeadline = setTimeout(() => controller.abort('timeout'), 5_000)
      try {
        const response = await Promise.race([aborted, driver.observeRpc(options.observeRpc)])
        controller.signal.throwIfAborted()
        result.rpcResponse = response
      } finally {
        clearTimeout(observationDeadline)
      }
    }
  }

  /** Callbacks the driver invokes; each ignores events after the probe stops. */
  private connection(): VoiceProbeConnection {
    const { controller, options, result } = this
    return {
      room: {
        url: this.url,
        apiKey: options.room?.apiKey ?? process.env.LIVEKIT_API_KEY,
        apiSecret: options.room?.apiSecret ?? process.env.LIVEKIT_API_SECRET,
      },
      roomName: result.roomName,
      agentName: options.agentName,
      sampleRate: options.input.sampleRate,
      participantAttributes: options.participantAttributes ?? {},
      signal: controller.signal,
      observeData: options.observeData,
      onAudio: (pcm, rate) => {
        if (controller.signal.aborted) return
        const ms = (pcm.length / rate) * 1000
        result.receivedAudioMs += ms
        if (hasSpeech(pcm)) result.receivedNonSilentAudioMs += ms
        recordAudio(result.audioActivity, 'agent', pcm, rate)
      },
      onTranscript: (text, segmentId) => {
        if (controller.signal.aborted) return
        this.transcripts.set(segmentId, text)
        result.assistantTranscripts = [...this.transcripts.values()]
      },
      onError: () => {
        controller.abort('transport')
      },
      onData: (payload) => {
        if (!controller.signal.aborted)
          result.observations?.push({ receivedAtMs: Date.now() - this.started, payload })
      },
      onRemoteDisconnect: (reason) => {
        if (controller.signal.aborted) return
        result.remoteDisconnect = { atMs: Date.now() - this.started, reason }
        controller.abort('remote-disconnect')
      },
    }
  }

  private async closeDriver(): Promise<void> {
    if (!this.driver) return
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.driver.close(),
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error('Cleanup timeout')), 5_000)
        }),
      ])
    } catch {
      this.result.status = 'error'
      this.result.error = 'Voice probe cleanup failed'
    } finally {
      clearTimeout(cleanupTimer)
    }
  }
}

/** Standalone CLI shutdown only: disposes ADK's process-wide RTC runtime after all sessions finish. */
export async function disposeVoiceProbeRuntime(): Promise<void> {
  const rtc = await import('@livekit/rtc-node')
  await rtc.dispose()
}
