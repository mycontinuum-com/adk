import type { StateSchema } from '../../types/schema'
import type {
  VoiceEvalCase,
  VoiceEvalCaseFactory,
  VoiceEvalControl,
  VoiceEvalControlBinding,
  VoiceEvalControlDisconnectOptions,
} from './types'

interface InternalVoiceEvalControl extends VoiceEvalControl {
  bind(binding: VoiceEvalControlBinding): () => void
}

function assertInternal(control: VoiceEvalControl): InternalVoiceEvalControl {
  if (typeof (control as Partial<InternalVoiceEvalControl>).bind !== 'function') {
    throw new Error('[adk/voice-eval] Voice eval control was not created by ADK')
  }
  return control as InternalVoiceEvalControl
}

function requireBinding(binding: VoiceEvalControlBinding | undefined): VoiceEvalControlBinding {
  if (!binding) {
    throw new Error('[adk/voice-eval] Voice eval control is not bound to an active case run')
  }
  return binding
}

export function createVoiceEvalControl(): VoiceEvalControl {
  let activeBinding: VoiceEvalControlBinding | undefined
  const control: InternalVoiceEvalControl = {
    disconnectUser: (options?: VoiceEvalControlDisconnectOptions) =>
      requireBinding(activeBinding).disconnectUser(options),
    bind: (binding: VoiceEvalControlBinding) => {
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

export function bindVoiceEvalControl(
  control: VoiceEvalControl,
  binding: VoiceEvalControlBinding,
): () => void {
  return assertInternal(control).bind(binding)
}

export function createVoiceEvalCase<S extends StateSchema>(
  input: VoiceEvalCase<S> | VoiceEvalCaseFactory<S>,
): VoiceEvalCase<S> {
  if (typeof input !== 'function') return input

  const control = createVoiceEvalControl()
  return {
    ...input(control),
    evalControl: control,
  }
}
