import type { RealtimeModelConfig, ProviderModelConfig } from '../types/runnables'
import type { VoiceDeps } from './livekit-types'

import { getModelProvider, getModelName, getInnerModel } from '../providers/models'
import { resolveOpenAIConnection } from '../providers/openai-endpoints'
import { defaultVoiceDeps } from './livekit-types'

export interface LiveKitModelResult {
  llm: unknown
  stt?: unknown
  tts?: unknown
}

/**
 * Convert an ADK RealtimeModelConfig into the LiveKit model instances needed for a
 * voice.AgentSession.
 */
export function createLiveKitModel(
  config: RealtimeModelConfig,
  deps: VoiceDeps = defaultVoiceDeps,
): LiveKitModelResult {
  if (config.stt && !config.tts) {
    throw new Error(
      'Invalid realtime config: stt without tts is not supported. ' +
        'Provide both stt and tts for a full pipeline, or tts alone for half-cascade.',
    )
  }

  const provider = getModelProvider(config)

  if (provider === 'openai') return createOpenAIModel(config, deps)
  if (provider === 'gemini') return createGeminiModel(config, deps)

  throw new Error(`Unsupported provider for voice mode: '${provider}'. Use 'openai' or 'gemini'.`)
}

// --- Shared helpers ---

/** Extract common realtime model options from the config. */
function buildBaseOpts(config: RealtimeModelConfig): {
  opts: Record<string, unknown>
  innerModel: ProviderModelConfig
} {
  const innerModel = getInnerModel(config)
  const opts: Record<string, unknown> = { model: getModelName(config) }
  if (config.voice) opts.voice = config.voice
  if (innerModel.temperature != null) opts.temperature = innerModel.temperature
  return { opts, innerModel }
}

// --- Provider-specific factories ---

function createOpenAIModel(config: RealtimeModelConfig, deps: VoiceDeps): LiveKitModelResult {
  const openai = deps.openai()
  const { opts, innerModel } = buildBaseOpts(config)

  const conn = resolveOpenAIConnection()
  if (conn) Object.assign(opts, conn)

  // Full pipeline: standard LLM + external STT/TTS
  if (config.stt && config.tts) {
    return {
      llm: new openai.LLM({
        model: opts.model,
        temperature: innerModel.temperature,
        ...conn,
        ...config.providerOptions,
      }),
      stt: config.stt,
      tts: config.tts,
    }
  }

  // Realtime model (full-realtime or half-cascade with text-only modalities)
  if (innerModel.maxTokens != null) opts.maxResponseOutputTokens = innerModel.maxTokens
  if (config.tts) opts.modalities = ['text']

  const td = config.turnDetection
  if (td) {
    opts.turnDetection = {
      type: td.type === 'semantic' ? 'semantic_vad' : 'server_vad',
      ...(td.threshold != null && { threshold: td.threshold }),
      ...(td.silenceDurationMs != null && { silence_duration_ms: td.silenceDurationMs }),
      ...(td.prefixPaddingMs != null && { prefix_padding_ms: td.prefixPaddingMs }),
    }
  }

  if (config.inputTranscription) {
    opts.inputAudioTranscription = {
      model: config.inputTranscription.model,
      ...(config.inputTranscription.prompt != null && { prompt: config.inputTranscription.prompt }),
    }
  }

  if (config.noiseReduction) {
    opts.inputAudioNoiseReduction = { type: config.noiseReduction.type }
  }

  if (config.providerOptions) Object.assign(opts, config.providerOptions)

  const result: LiveKitModelResult = { llm: new openai.realtime.RealtimeModel(opts) }
  if (config.tts) result.tts = config.tts
  return result
}

function createGeminiModel(config: RealtimeModelConfig, deps: VoiceDeps): LiveKitModelResult {
  const google = deps.google()
  const { opts, innerModel } = buildBaseOpts(config)

  // Full pipeline: standard LLM + external STT/TTS
  if (config.stt && config.tts) {
    return {
      llm: new google.LLM({
        model: opts.model,
        temperature: innerModel.temperature,
        ...config.providerOptions,
      }),
      stt: config.stt,
      tts: config.tts,
    }
  }

  // Realtime model — apply Vertex AI config if present
  if ('vertex' in innerModel && innerModel.vertex) {
    opts.vertexai = true
    opts.project = innerModel.vertex.project
    opts.location = innerModel.vertex.location
  }

  if (innerModel.maxTokens != null) opts.maxOutputTokens = innerModel.maxTokens
  if (config.tts) opts.modalities = ['TEXT']

  const td = config.turnDetection
  if (td) {
    opts.realtimeInputConfig = {
      automaticActivityDetection: {
        disabled: false,
        ...(td.silenceDurationMs != null && { silenceDurationMs: td.silenceDurationMs }),
        ...(td.prefixPaddingMs != null && { prefixPaddingMs: td.prefixPaddingMs }),
      },
    }
  }

  if (config.providerOptions) Object.assign(opts, config.providerOptions)

  const result: LiveKitModelResult = { llm: new google.beta.realtime.RealtimeModel(opts) }
  if (config.tts) result.tts = config.tts
  return result
}
