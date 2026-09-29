import type { NoiseCancellationType } from './types'

/**
 * A noise filter for LiveKit's `inputOptions.noiseCancellation`: the shape of LiveKit's
 * `NoiseCancellationOptions`, which each factory of `@livekit/noise-cancellation-node` returns.
 */
export interface NoiseCancellationFilter {
  moduleId: string
  options: Record<string, unknown>
}

/** The part of `@livekit/noise-cancellation-node` the voice handlers use. */
export interface NoiseCancellationModule {
  BackgroundVoiceCancellation: () => unknown
  TelephonyBackgroundVoiceCancellation: () => unknown
}

let _nc: NoiseCancellationModule | undefined

function isNoiseCancellationModule(value: unknown): value is NoiseCancellationModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'BackgroundVoiceCancellation' in value &&
    typeof value.BackgroundVoiceCancellation === 'function' &&
    'TelephonyBackgroundVoiceCancellation' in value &&
    typeof value.TelephonyBackgroundVoiceCancellation === 'function'
  )
}

function isNoiseCancellationFilter(value: unknown): value is NoiseCancellationFilter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'moduleId' in value &&
    typeof value.moduleId === 'string' &&
    'options' in value &&
    typeof value.options === 'object' &&
    value.options !== null
  )
}

/**
 * Loads `@livekit/noise-cancellation-node`, an optional peer, once per process. Throws the module
 * resolution error when it is not installed, and an error when it lacks the two factories; only a
 * call whose handler or setup asks for noise cancellation loads it.
 */
export function loadNoiseCancellation(): NoiseCancellationModule {
  if (_nc) return _nc
  const loaded: unknown = require('@livekit/noise-cancellation-node')
  if (!isNoiseCancellationModule(loaded))
    throw new Error('@livekit/noise-cancellation-node does not export its noise filter factories')
  return (_nc = loaded)
}

/**
 * The LiveKit input filter for a noise cancellation profile, for `inputOptions.noiseCancellation`.
 * Throws when the module's factory returns something other than a LiveKit noise filter, so a call
 * fails as it starts rather than inside LiveKit.
 */
export function resolveNoiseCancellation(
  type: NoiseCancellationType,
  nc: NoiseCancellationModule = loadNoiseCancellation(),
): NoiseCancellationFilter {
  const filter =
    type === 'telephony'
      ? nc.TelephonyBackgroundVoiceCancellation()
      : nc.BackgroundVoiceCancellation()
  if (!isNoiseCancellationFilter(filter))
    throw new Error(`@livekit/noise-cancellation-node returned no ${type} noise filter`)
  return filter
}
