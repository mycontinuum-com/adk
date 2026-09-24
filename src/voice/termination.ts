import type { JobContext, VoiceDeps } from './livekit-types'
import type { CallTerminationConfig, VoiceEvent } from './types'

interface TerminateLiveKitCallOptions {
  config: false | CallTerminationConfig | undefined
  deps: Pick<VoiceDeps, 'livekitServer'>
  ctx: Pick<JobContext, 'shutdown'> & { room: Pick<JobContext['room'], 'name'> }
  participantIdentity?: string
  onVoiceEvent?: (event: VoiceEvent) => void
}

/**
 * Shuts down the LiveKit job and then deletes the room or removes the caller, as `config` selects.
 * Does nothing when `config` is `false`. Reports failures through `onVoiceEvent` instead of
 * throwing; a room that is already gone is not a failure.
 */
export async function terminateLiveKitCall(opts: TerminateLiveKitCallOptions): Promise<void> {
  const termination = resolveCallTermination(opts.config)
  if (!termination) return

  try {
    opts.ctx.shutdown?.('Session ended')
  } catch (error) {
    opts.onVoiceEvent?.({ type: 'voice_error', error })
  }

  const roomName = opts.ctx.room.name
  if (!roomName) {
    opts.onVoiceEvent?.({
      type: 'voice_error',
      error: new Error('Cannot terminate LiveKit call: room name is unavailable.'),
    })
    return
  }

  if (termination.strategy === 'removeParticipant' && !opts.participantIdentity) {
    opts.onVoiceEvent?.({
      type: 'voice_error',
      error: new Error('Cannot remove LiveKit participant: participant identity is unavailable.'),
    })
    return
  }

  try {
    const { RoomServiceClient } = opts.deps.livekitServer()
    const client = new RoomServiceClient(
      resolveLiveKitHttpUrl(termination.livekitUrl),
      termination.apiKey ?? process.env.LIVEKIT_API_KEY ?? 'devkey',
      termination.apiSecret ?? process.env.LIVEKIT_API_SECRET ?? 'secret',
    )
    if (termination.strategy === 'removeParticipant') {
      await client.removeParticipant(roomName, opts.participantIdentity!)
    } else {
      await client.deleteRoom(roomName)
    }
  } catch (error) {
    if (isMissingRoomError(error)) return
    opts.onVoiceEvent?.({ type: 'voice_error', error })
  }
}

type ResolvedCallTermination = Required<Pick<CallTerminationConfig, 'strategy'>> &
  Omit<CallTerminationConfig, 'strategy'>

function resolveCallTermination(
  config: false | CallTerminationConfig | undefined,
): ResolvedCallTermination | false {
  if (config === false) return false
  return {
    ...config,
    strategy: config?.strategy ?? 'deleteRoom',
  }
}

function resolveLiveKitHttpUrl(configuredUrl?: string): string {
  const url = configuredUrl ?? process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880'
  if (url.startsWith('wss://')) return `https://${url.slice('wss://'.length)}`
  if (url.startsWith('ws://')) return `http://${url.slice('ws://'.length)}`
  return url
}

function isMissingRoomError(error: unknown): boolean {
  const status = getErrorStatus(error)
  if (status === 404) return true
  const message = error instanceof Error ? error.message : String(error)
  return /room.*(not found|does not exist)|not found.*room/i.test(message)
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const status = record.status ?? record.statusCode ?? record.code
  if (typeof status === 'number') return status
  if (typeof status === 'string') {
    const parsed = Number(status)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
