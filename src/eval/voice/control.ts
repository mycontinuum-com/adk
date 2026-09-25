import type { StateSchema } from '../../types/schema'
import type {
  VoiceEvalCase,
  VoiceEvalCaseFactory,
  VoiceEvalControl,
  VoiceEvalControlDisconnectOptions,
} from './types'

type BindableVoiceEvalControl = NonNullable<VoiceEvalCase['evalControl']>

function requireBinding(binding: VoiceEvalControl | undefined): VoiceEvalControl {
  if (!binding) {
    throw new Error('[adk/voice-eval] Voice eval control is not bound to an active case run')
  }
  return binding
}

function createVoiceEvalControl(): BindableVoiceEvalControl {
  let activeBinding: VoiceEvalControl | undefined
  const control: BindableVoiceEvalControl = {
    disconnectUser: (options?: VoiceEvalControlDisconnectOptions) =>
      requireBinding(activeBinding).disconnectUser(options),
    muteUser: (muted: boolean) => requireBinding(activeBinding).muteUser(muted),
    bind: (binding: VoiceEvalControl) => {
      activeBinding = binding
      return () => {
        if (activeBinding === binding) {
          activeBinding = undefined
        }
      }
    },
  }
  return control
}

/**
 * Returns a voice eval case. A factory receives a fresh eval control, which the runner binds to the
 * case's room while it runs.
 */
export function createVoiceEvalCase<S extends StateSchema, T>(
  input: VoiceEvalCase<S, T> | VoiceEvalCaseFactory<S, T>,
): VoiceEvalCase<S, T> {
  if (typeof input !== 'function') return input

  const control = createVoiceEvalControl()
  return {
    ...input(control),
    evalControl: control,
  }
}
