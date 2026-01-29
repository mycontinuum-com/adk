import type { OpenAIModel, GeminiModel, ClaudeModel } from '../types';

/**
 * Configure an OpenAI model for use with an agent.
 * @param name - Model name (e.g., 'gpt-4o-mini', 'gpt-4o', 'o1')
 * @param config - Optional model settings
 * @param config.temperature - Sampling temperature (0-2)
 * @param config.maxTokens - Maximum tokens in response
 * @param config.reasoning - Reasoning config for o-series models
 * @param config.retry - Retry configuration
 * @returns OpenAI model configuration
 * @example
 * openai('gpt-4o-mini')
 * openai('gpt-4o', { temperature: 0.7 })
 * openai('o1', { reasoning: { effort: 'medium' } })
 */
export function openai(
  name: string,
  config?: Omit<OpenAIModel, 'provider' | 'name'>,
): OpenAIModel {
  return { provider: 'openai', name, ...config };
}

/**
 * Configure a Gemini model for use with an agent.
 * @param name - Model name (e.g., 'gemini-2.0-flash')
 * @param config - Optional model settings
 * @param config.temperature - Sampling temperature
 * @param config.maxTokens - Maximum tokens in response
 * @param config.thinkingConfig - Thinking/reasoning configuration
 * @param config.vertex - Vertex AI configuration (project, location)
 * @param config.retry - Retry configuration
 * @returns Gemini model configuration
 * @example
 * gemini('gemini-2.0-flash')
 * gemini('gemini-2.0-flash', { temperature: 0.5 })
 * gemini('gemini-2.0-flash', { thinkingConfig: { thinkingLevel: 'medium' } })
 * gemini('gemini-2.0-flash', { vertex: { project: 'my-project', location: 'us-central1' } })
 */
export function gemini(
  name: string,
  config?: Omit<GeminiModel, 'provider' | 'name'>,
): GeminiModel {
  return { provider: 'gemini', name, ...config };
}

/**
 * Configure a Claude model for use with an agent via Google Vertex AI.
 * @param name - Model name (e.g., 'claude-sonnet-4-20250514', 'claude-opus-4-20250514')
 * @param config - Model settings including required Vertex AI configuration
 * @param config.vertex - Required Vertex AI configuration
 * @param config.vertex.project - Google Cloud project ID
 * @param config.vertex.location - Google Cloud region (e.g., 'us-east5', 'europe-west1')
 * @param config.temperature - Sampling temperature
 * @param config.maxTokens - Maximum tokens in response
 * @param config.thinking - Extended thinking configuration
 * @param config.retry - Retry configuration
 * @returns Claude model configuration
 * @example
 * claude('claude-sonnet-4-20250514', { vertex: { project: 'my-project', location: 'us-east5' } })
 * claude('claude-opus-4-20250514', { vertex: { project: 'my-project', location: 'us-east5' }, thinking: { budgetTokens: 2048 } })
 */
export function claude(
  name: string,
  config: Omit<ClaudeModel, 'provider' | 'name'>,
): ClaudeModel {
  return { provider: 'claude', name, ...config };
}
