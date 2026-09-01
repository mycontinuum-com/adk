import type {
  OpenAIModel,
  GeminiModel,
  ClaudeModel,
  ModelConfig,
  ProviderModelConfig,
  RealtimeModelConfig,
  TurnDetectionConfig,
  InputTranscriptionConfig,
  NoiseReductionConfig,
  VertexAIConfig,
  Provider,
} from '../types/runnables'

/** Check whether a ModelConfig is a RealtimeModelConfig wrapper. */
export function isRealtimeConfig(config: ModelConfig): config is RealtimeModelConfig {
  return 'realtime' in config && config.realtime === true
}

/** Extract the inner provider model from any ModelConfig. */
export function getInnerModel(config: ModelConfig): ProviderModelConfig {
  return isRealtimeConfig(config) ? config.model : config
}

/** Extract the provider string from any ModelConfig. */
export function getModelProvider(config: ModelConfig): Provider {
  return getInnerModel(config).provider
}

/** Extract the model name from any ModelConfig. */
export function getModelName(config: ModelConfig): string {
  return getInnerModel(config).name
}

export interface RealtimeOptions {
  voice?: string
  turnDetection?: TurnDetectionConfig
  inputTranscription?: InputTranscriptionConfig
  noiseReduction?: NoiseReductionConfig
  stt?: unknown
  tts?: unknown
  providerOptions?: Record<string, unknown>
}

/**
 * Wrap a provider model config for realtime (voice-capable) use.
 *
 * @example
 *   realtime({ model: openai('gpt-4o-realtime') })
 *   realtime({
 *     model: openai('gpt-4o-realtime'),
 *     voice: 'alloy',
 *     turnDetection: { silenceDurationMs: 500 },
 *   })
 *   realtime({ model: openai('gpt-4o'), stt: deepgramSTT, tts: elevenLabsTTS })
 */
export function realtime(
  config: { model: ProviderModelConfig } & RealtimeOptions,
): RealtimeModelConfig {
  return { realtime: true, name: config.model.name, ...config }
}

// --- Provider factories ---

function createOpenAI(name: string, config?: Omit<OpenAIModel, 'provider' | 'name'>): OpenAIModel {
  return { provider: 'openai', name, ...config }
}

function createGemini(name: string, config?: Omit<GeminiModel, 'provider' | 'name'>): GeminiModel {
  return { provider: 'gemini', name, ...config }
}

interface OpenAIRealtimeOptions extends RealtimeOptions {
  temperature?: number
  maxTokens?: number
}

interface GeminiRealtimeOptions extends RealtimeOptions {
  temperature?: number
  maxTokens?: number
  vertex?: VertexAIConfig
}

interface OpenAIFactory {
  (name: string, config?: Omit<OpenAIModel, 'provider' | 'name'>): OpenAIModel
  realtime(name: string, config?: OpenAIRealtimeOptions): RealtimeModelConfig
}

interface GeminiFactory {
  (name: string, config?: Omit<GeminiModel, 'provider' | 'name'>): GeminiModel
  realtime(name: string, config?: GeminiRealtimeOptions): RealtimeModelConfig
}

/**
 * Configure an OpenAI model for use with an agent.
 *
 * @example
 *   openai('gpt-4o-mini')
 *   openai('gpt-4o', { temperature: 0.7 })
 *   openai('o1', { reasoning: { effort: 'medium' } })
 *   openai.realtime('gpt-4o-realtime')
 *   openai.realtime('gpt-4o-realtime', { voice: 'alloy' })
 */
export const openai: OpenAIFactory = Object.assign(createOpenAI, {
  realtime(name: string, config?: OpenAIRealtimeOptions): RealtimeModelConfig {
    const {
      voice,
      turnDetection,
      inputTranscription,
      noiseReduction,
      stt,
      tts,
      providerOptions,
      ...modelConfig
    } = config ?? {}
    return realtime({
      model: createOpenAI(name, modelConfig),
      voice,
      turnDetection,
      inputTranscription,
      noiseReduction,
      stt,
      tts,
      providerOptions,
    })
  },
})

/**
 * Configure a Gemini model for use with an agent.
 *
 * @example
 *   gemini('gemini-2.0-flash')
 *   gemini('gemini-2.0-flash', { temperature: 0.5 })
 *   gemini.realtime('gemini-2.0-flash-live', { voice: 'Puck' })
 */
export const gemini: GeminiFactory = Object.assign(createGemini, {
  realtime(name: string, config?: GeminiRealtimeOptions): RealtimeModelConfig {
    const {
      voice,
      turnDetection,
      inputTranscription,
      noiseReduction,
      stt,
      tts,
      providerOptions,
      ...modelConfig
    } = config ?? {}
    return realtime({
      model: createGemini(name, modelConfig),
      voice,
      turnDetection,
      inputTranscription,
      noiseReduction,
      stt,
      tts,
      providerOptions,
    })
  },
})

/**
 * Configure a Claude model for use with an agent via Google Vertex AI.
 *
 * @example
 *   claude('claude-sonnet-4-20250514', { vertex: { project: 'my-project', location: 'us-east5' } })
 */
export function claude(name: string, config: Omit<ClaudeModel, 'provider' | 'name'>): ClaudeModel {
  return { provider: 'claude', name, ...config }
}
