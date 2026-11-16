import { configurePricing, loadPricing, parsePricingCatalog } from '../providers/pricing'

/**
 * Registry entries, in LiteLLM's format, for the models the cost tests price. The tier, uplift and
 * Voyage rates are the live list's of 15 November 2026.
 */
const REGISTRY = {
  'gpt-6-luna': {
    litellm_provider: 'openai',
    input_cost_per_token: 1e-7,
    input_cost_per_token_flex: 5e-8,
    input_cost_per_token_priority: 2e-7,
    input_cost_per_token_above_272k_tokens: 2e-7,
    input_cost_per_token_above_272k_tokens_priority: 4e-7,
    input_cost_per_token_batches: 5e-8,
    output_cost_per_token: 5e-7,
    output_cost_per_token_flex: 2.5e-7,
    output_cost_per_token_priority: 1e-6,
    output_cost_per_token_above_272k_tokens: 7.5e-7,
    output_cost_per_token_above_272k_tokens_priority: 1.5e-6,
    regional_processing_uplift_multiplier_eu: 1.1,
    regional_processing_uplift_multiplier_us: 1.1,
  },
  'vertex_ai/claude-opus-5': {
    litellm_provider: 'vertex_ai-anthropic_models',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    regional_endpoint_uplift_multiplier: 1.1,
  },
  'gemini/gemini-3.5-flash': {
    litellm_provider: 'gemini',
    input_cost_per_token: 3e-7,
    output_cost_per_token: 2.5e-6,
  },
  'vertex_ai/gemini-3.5-flash': {
    litellm_provider: 'vertex_ai',
    input_cost_per_token: 3e-7,
    output_cost_per_token: 2.5e-6,
    regional_endpoint_uplift_multiplier: 1.1,
  },
  'voyage/voyage-3.5': {
    litellm_provider: 'voyage',
    mode: 'embedding',
    input_cost_per_token: 6e-8,
    output_cost_per_token: 0,
  },
  'gpt-4o-mini': {
    litellm_provider: 'openai',
    input_cost_per_token: 1.5e-7,
    cache_read_input_token_cost: 7.5e-8,
    output_cost_per_token: 6e-7,
  },
  'gpt-live-1': { litellm_provider: 'openai', mode: 'realtime', input_cost_per_second: 0.05 / 60 },
  'gpt-realtime': {
    litellm_provider: 'openai',
    input_cost_per_token: 4e-6,
    cache_read_input_token_cost: 4e-7,
    output_cost_per_token: 1.6e-5,
    input_cost_per_audio_token: 3.2e-5,
    cache_read_input_audio_token_cost: 4e-7,
    output_cost_per_audio_token: 6.4e-5,
  },
}

export const TEST_PRICING = parsePricingCatalog(REGISTRY)

/** Serves the test registry through the real fetch path, without the network. */
export async function useTestPricing(): Promise<void> {
  configurePricing({
    url: `data:application/json,${encodeURIComponent(JSON.stringify(REGISTRY))}`,
  })
  await loadPricing()
}
