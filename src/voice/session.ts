import type { ToolChoice } from '../types/runnables'
import type { LKAgentSession, LKBackgroundAudioPlayer } from './livekit-types'
import type { VoiceSession, VoiceReply, PlayHandle } from './types'

export type VoiceGenerateReplyOptions = {
  userInput?: string
  instructions?: string
  toolChoice?: ToolChoice
  allowInterruptions?: boolean
}

interface LiveKitVoiceSessionOptions {
  onGenerateReply?: (
    options: VoiceGenerateReplyOptions | undefined,
    generate: (options: VoiceGenerateReplyOptions | undefined) => Promise<VoiceReply>,
  ) => Promise<VoiceReply>
}

function mapToolChoice(tc?: ToolChoice): string | object | undefined {
  if (tc == null) return undefined
  if (typeof tc === 'string') return tc
  return { type: 'function', function: { name: tc.name } }
}

/**
 * LiveKit-backed VoiceSession implementation. Wraps LiveKit's AgentSession to provide the ADK
 * VoiceSession interface.
 *
 * This implementation is only instantiated in audio mode (via the voice handler). In text mode,
 * ctx.voice is undefined.
 *
 * `shutdown()` and `setBgAudio()` are internal — not part of VoiceSession.
 */
export class LiveKitVoiceSession implements VoiceSession {
  private lk: LKAgentSession
  private options: LiveKitVoiceSessionOptions
  private bgAudio: LKBackgroundAudioPlayer | undefined
  private shutdownCalled = false
  turnCount = 0

  constructor(agentSession: LKAgentSession, options: LiveKitVoiceSessionOptions = {}) {
    this.lk = agentSession
    this.options = options
  }

  /** @internal Set the background audio player after it's started. */
  setBgAudio(player: LKBackgroundAudioPlayer): void {
    this.bgAudio = player
  }

  async generateReply(options?: VoiceGenerateReplyOptions): Promise<VoiceReply> {
    if (this.options.onGenerateReply) {
      return this.options.onGenerateReply(options, (next) => this.generateReplyDirect(next))
    }
    return this.generateReplyDirect(options)
  }

  async generateReplyDirect(options?: VoiceGenerateReplyOptions): Promise<VoiceReply> {
    if (this.shutdownCalled) {
      throw new Error('Cannot generate reply after shutdown')
    }

    let lkOpts: Record<string, unknown> | undefined
    if (options) {
      const { toolChoice, ...rest } = options
      lkOpts = { ...rest, ...(toolChoice != null && { toolChoice: mapToolChoice(toolChoice) }) }
    }
    const lkReply = this.lk.generateReply(lkOpts)

    return {
      async waitForPlayout(): Promise<void> {
        if (lkReply && typeof lkReply === 'object' && 'waitForPlayout' in lkReply) {
          await (lkReply as { waitForPlayout(): Promise<void> }).waitForPlayout()
        }
      },
    }
  }

  async say(
    text: string,
    options?: { audio?: AsyncIterable<unknown>; allowInterruptions?: boolean },
  ): Promise<VoiceReply> {
    if (this.shutdownCalled) {
      throw new Error('Cannot say after shutdown')
    }
    if (!this.lk.say) {
      throw new Error(
        'say() requires a TTS plugin on the AgentSession. ' +
          'Add a TTS model to your agent config or use generateReply() instead.',
      )
    }
    const handle = this.lk.say(text, options)
    return {
      async waitForPlayout(): Promise<void> {
        await handle.waitForPlayout()
      },
    }
  }

  playSound(source: string, options?: { volume?: number; loop?: boolean }): PlayHandle | undefined {
    if (!this.bgAudio) return undefined
    const audio = options?.volume != null ? { source, volume: options.volume } : source
    const handle = this.bgAudio.play(audio, options?.loop)
    return {
      stop: () => handle.stop(),
      waitForPlayout: () => handle.waitForPlayout(),
    }
  }

  /** Internal — called by the lifecycle state machine, not exposed on VoiceSession. */
  shutdown(options?: { reason?: string }): void {
    if (this.shutdownCalled) return
    this.shutdownCalled = true

    if (this.lk.shutdown) {
      this.lk.shutdown(options)
    } else if (this.lk.close) {
      this.lk.close()
    }
  }

  interrupt(): void {
    if (this.lk.interrupt) {
      this.lk.interrupt()
    }
  }
}
