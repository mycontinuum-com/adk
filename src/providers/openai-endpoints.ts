export interface OpenAIEndpoint {
  type: 'azure' | 'openai';
  baseUrl?: string;
  apiVersion?: string;
  apiKey?: string;
  modelMapping?: Record<string, string>;
}

// TODO: Rename all azure deployments to follow the same pattern as openai
const AZURE_MODEL_MAPPING: Record<string, string> = {
  'gpt-4o': 'gpt-4o-v2024-08-06',
  'gpt-4o-mini': 'gpt-4o-mini-v2024-07-18',
  'gpt-5': 'gpt-5-v2025-08-07',
  'gpt-5-mini': 'gpt-5-mini-v2025-08-07',
  'gpt-5-nano': 'gpt-5-nano-v2025-08-07',
  o3: 'o3-v2025-04-16',
  'o3-mini': 'o3-mini-v2025-01-31',
  'o4-mini': 'o4-mini-v2025-04-16',
};

const OPENAI_MODEL_MAPPING: Record<string, string> = {
  'gpt-4o': 'gpt-4o-2024-08-06',
  'gpt-4o-mini': 'gpt-4o-mini-2024-07-18',
  'gpt-5': 'gpt-5-2025-08-07',
  'gpt-5-mini': 'gpt-5-mini-2025-08-07',
  'gpt-5-nano': 'gpt-5-nano-2025-08-07',
  o3: 'o3-2025-04-16',
  'o3-mini': 'o3-mini-2025-01-31',
  'o4-mini': 'o4-mini-2025-04-16',
};

export function resolveModelName(
  logicalName: string,
  endpoint: OpenAIEndpoint,
): string {
  return endpoint.modelMapping?.[logicalName] ?? logicalName;
}

export function getDefaultEndpoints(): OpenAIEndpoint[] {
  const endpoints: OpenAIEndpoint[] = [];

  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
    endpoints.push({
      type: 'azure',
      baseUrl: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2025-01-01-preview',
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      modelMapping: AZURE_MODEL_MAPPING,
    });
  }

  if (process.env.OPENAI_EU_API_KEY) {
    endpoints.push({
      type: 'openai',
      baseUrl: 'https://eu.api.openai.com/v1',
      apiKey: process.env.OPENAI_EU_API_KEY,
      modelMapping: OPENAI_MODEL_MAPPING,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    endpoints.push({
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      modelMapping: OPENAI_MODEL_MAPPING,
    });
  }

  if (endpoints.length === 0) {
    throw new Error(
      `No OpenAI API key configured.

Set one of these environment variables:
  - OPENAI_API_KEY                                  (Standard OpenAI)
  - OPENAI_EU_API_KEY                               (OpenAI EU region)
  - AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY    (Azure OpenAI)`,
    );
  }

  return endpoints;
}

export function isRetryableForFallback(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes('rate limit')) return true;
  if (msg.includes('timeout')) return true;
  if (msg.includes('500')) return true;
  if (msg.includes('502')) return true;
  if (msg.includes('503')) return true;
  if (msg.includes('connection')) return true;
  if (msg.includes('model not found')) return true;
  if (msg.includes('deployment not found')) return true;
  return false;
}
