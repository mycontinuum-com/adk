import { configurePricing, parsePricingCatalog } from '../providers/pricing'

/** Registry entries, in LiteLLM's format, for the models the Live cost tests price. */
const REGISTRY = {
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
export function useTestPricing(): void {
  configurePricing({
    url: `data:application/json,${encodeURIComponent(JSON.stringify(REGISTRY))}`,
  })
}
