import {
  resolveModelName,
  getDefaultEndpoints,
  isRetryableForFallback,
  type OpenAIEndpoint,
} from './openai-endpoints';

describe('openai-endpoints', () => {
  describe('resolveModelName', () => {
    it('should return mapped name when mapping exists', () => {
      const endpoint: OpenAIEndpoint = {
        type: 'azure',
        modelMapping: { 'gpt-5-mini': 'gpt-5-mini-v2025-08-07' },
      };
      expect(resolveModelName('gpt-5-mini', endpoint)).toBe(
        'gpt-5-mini-v2025-08-07',
      );
    });

    it('should pass through unmapped model names', () => {
      const endpoint: OpenAIEndpoint = {
        type: 'azure',
        modelMapping: { 'gpt-5-mini': 'gpt-5-mini-v2025-08-07' },
      };
      expect(resolveModelName('custom-model-name', endpoint)).toBe(
        'custom-model-name',
      );
    });

    it('should pass through when no mapping configured', () => {
      const endpoint: OpenAIEndpoint = { type: 'openai' };
      expect(resolveModelName('gpt-5-mini', endpoint)).toBe('gpt-5-mini');
    });

    it('should pass through exact versioned names', () => {
      const endpoint: OpenAIEndpoint = {
        type: 'openai',
        modelMapping: { 'gpt-5-mini': 'gpt-5-mini-2025-08-07' },
      };
      expect(resolveModelName('gpt-5-mini-2025-08-07', endpoint)).toBe(
        'gpt-5-mini-2025-08-07',
      );
    });
  });

  describe('getDefaultEndpoints', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_API_KEY;
      delete process.env.AZURE_OPENAI_API_VERSION;
      delete process.env.OPENAI_EU_API_KEY;
      delete process.env.OPENAI_API_KEY;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should throw helpful error when no env vars set', () => {
      expect(() => getDefaultEndpoints()).toThrow(
        'No OpenAI API key configured',
      );
      expect(() => getDefaultEndpoints()).toThrow('OPENAI_API_KEY');
      expect(() => getDefaultEndpoints()).toThrow('OPENAI_EU_API_KEY');
      expect(() => getDefaultEndpoints()).toThrow('AZURE_OPENAI_ENDPOINT');
    });

    it('should include azure endpoint first when configured', () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-key';

      const endpoints = getDefaultEndpoints();
      expect(endpoints[0].type).toBe('azure');
      expect(endpoints[0].baseUrl).toBe('https://test.openai.azure.com');
      expect(endpoints[0].apiVersion).toBe('2025-01-01-preview');
    });

    it('should use custom api version when set', () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-key';
      process.env.AZURE_OPENAI_API_VERSION = '2024-12-01';

      const endpoints = getDefaultEndpoints();
      expect(endpoints[0].apiVersion).toBe('2024-12-01');
    });

    it('should include EU endpoint when configured', () => {
      process.env.OPENAI_EU_API_KEY = 'eu-key';

      const endpoints = getDefaultEndpoints();
      expect(endpoints[0].type).toBe('openai');
      expect(endpoints[0].baseUrl).toBe('https://eu.api.openai.com/v1');
    });

    it('should create full fallback chain when all configured', () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-key';
      process.env.OPENAI_EU_API_KEY = 'eu-key';
      process.env.OPENAI_API_KEY = 'us-key';

      const endpoints = getDefaultEndpoints();
      expect(endpoints).toHaveLength(3);
      expect(endpoints[0].type).toBe('azure');
      expect(endpoints[1].type).toBe('openai');
      expect(endpoints[1].baseUrl).toBe('https://eu.api.openai.com/v1');
      expect(endpoints[2].type).toBe('openai');
      expect(endpoints[2].baseUrl).toBeUndefined();
    });

    it('should include model mappings in default endpoints', () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-key';
      process.env.OPENAI_API_KEY = 'us-key';

      const endpoints = getDefaultEndpoints();
      expect(endpoints[0].modelMapping?.['gpt-5-mini']).toBe(
        'gpt-5-mini-v2025-08-07',
      );
      expect(endpoints[1].modelMapping?.['gpt-5-mini']).toBe(
        'gpt-5-mini-2025-08-07',
      );
    });
  });

  describe('isRetryableForFallback', () => {
    it('should return true for rate limit errors', () => {
      expect(isRetryableForFallback(new Error('Rate limit exceeded'))).toBe(
        true,
      );
    });

    it('should return true for timeout errors', () => {
      expect(isRetryableForFallback(new Error('Request timeout'))).toBe(true);
    });

    it('should return true for 5xx errors', () => {
      expect(
        isRetryableForFallback(new Error('500 Internal Server Error')),
      ).toBe(true);
      expect(isRetryableForFallback(new Error('502 Bad Gateway'))).toBe(true);
      expect(isRetryableForFallback(new Error('503 Service Unavailable'))).toBe(
        true,
      );
    });

    it('should return true for connection errors', () => {
      expect(isRetryableForFallback(new Error('Connection refused'))).toBe(
        true,
      );
    });

    it('should return true for model/deployment not found', () => {
      expect(isRetryableForFallback(new Error('Model not found'))).toBe(true);
      expect(isRetryableForFallback(new Error('Deployment not found'))).toBe(
        true,
      );
    });

    it('should return false for non-error values', () => {
      expect(isRetryableForFallback('string')).toBe(false);
      expect(isRetryableForFallback(null)).toBe(false);
      expect(isRetryableForFallback(undefined)).toBe(false);
    });

    it('should return false for other errors', () => {
      expect(isRetryableForFallback(new Error('Invalid request'))).toBe(false);
      expect(isRetryableForFallback(new Error('Unauthorized'))).toBe(false);
    });
  });
});
