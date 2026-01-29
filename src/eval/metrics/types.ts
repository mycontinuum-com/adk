import type { Event } from '../../types';

export interface Metric {
  name: string;
  evaluate: (events: Event[]) => MetricResult | Promise<MetricResult>;
}

export interface MetricResult {
  passed: boolean;
  score?: number;
  value?: unknown;
  evidence?: string[];
}

export type EventFilter = (event: Event) => boolean;

export type StateAssertion<T = unknown> = (value: T | undefined) => boolean;

export type CountAssertion = (count: number) => boolean;
