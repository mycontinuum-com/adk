import { getPricing, calculateCost, formatCost } from './pricing';
import type { ModelUsage } from '../types';

describe('pricing', () => {
  describe('getPricing', () => {
    it('returns exact match for known model', () => {
      const pricing = getPricing('gpt-4o');
      expect(pricing).toEqual({
        inputPerMillion: 2.5,
        cachedInputPerMillion: 1.25,
        outputPerMillion: 10.0,
      });
    });

    it('returns prefix match for versioned model', () => {
      const pricing = getPricing('gpt-4o-2024-11-20');
      expect(pricing).toEqual({
        inputPerMillion: 2.5,
        cachedInputPerMillion: 1.25,
        outputPerMillion: 10.0,
      });
    });

    it('returns null for unknown model', () => {
      const pricing = getPricing('unknown-model-xyz');
      expect(pricing).toBeNull();
    });

    it('matches longer prefix first', () => {
      const pricing = getPricing('gpt-4o-mini-2024-11-20');
      expect(pricing).toEqual({
        inputPerMillion: 0.15,
        cachedInputPerMillion: 0.075,
        outputPerMillion: 0.6,
      });
    });

    it('returns pricing with reasoning tokens for gemini-2.5-pro', () => {
      const pricing = getPricing('gemini-2.5-pro');
      expect(pricing).toEqual({
        inputPerMillion: 1.25,
        cachedInputPerMillion: 0.125,
        reasoningPerMillion: 10.0,
        outputPerMillion: 10.0,
        highTier: {
          aboveTokens: 200_000,
          inputPerMillion: 2.5,
          cachedInputPerMillion: 0.25,
          reasoningPerMillion: 15.0,
          outputPerMillion: 15.0,
        },
      });
    });
  });

  describe('calculateCost', () => {
    it('calculates cost for simple usage', () => {
      const usage: ModelUsage = {
        inputTokens: 1000,
        outputTokens: 500,
      };
      const cost = calculateCost(usage, 'gpt-4o');
      expect(cost).toBeCloseTo(0.0025 + 0.005, 6);
    });

    it('accounts for cached tokens', () => {
      const usage: ModelUsage = {
        inputTokens: 1000,
        cachedTokens: 600,
        outputTokens: 500,
      };
      const cost = calculateCost(usage, 'gpt-4o');
      const expectedUncachedInput = (400 / 1_000_000) * 2.5;
      const expectedCachedInput = (600 / 1_000_000) * 1.25;
      const expectedOutput = (500 / 1_000_000) * 10.0;
      expect(cost).toBeCloseTo(
        expectedUncachedInput + expectedCachedInput + expectedOutput,
        6,
      );
    });

    it('accounts for reasoning tokens', () => {
      const usage: ModelUsage = {
        inputTokens: 1000,
        reasoningTokens: 2000,
        outputTokens: 500,
      };
      const cost = calculateCost(usage, 'gemini-2.5-pro');
      const expectedInput = (1000 / 1_000_000) * 1.25;
      const expectedReasoning = (2000 / 1_000_000) * 10.0;
      const expectedOutput = (500 / 1_000_000) * 10.0;
      expect(cost).toBeCloseTo(
        expectedInput + expectedReasoning + expectedOutput,
        6,
      );
    });

    it('returns null for unknown model', () => {
      const usage: ModelUsage = {
        inputTokens: 1000,
        outputTokens: 500,
      };
      const cost = calculateCost(usage, 'unknown-model');
      expect(cost).toBeNull();
    });
  });

  describe('formatCost', () => {
    it('formats costs with 2 significant digits', () => {
      expect(formatCost(0.0005)).toBe('$0.00050');
      expect(formatCost(0.005)).toBe('$0.0050');
      expect(formatCost(0.05)).toBe('$0.050');
      expect(formatCost(0.5)).toBe('$0.50');
      expect(formatCost(1.234)).toBe('$1.2');
      expect(formatCost(12.34)).toBe('$12');
    });
  });
});
