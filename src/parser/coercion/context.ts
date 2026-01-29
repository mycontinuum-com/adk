import type { Correction, CoercionError, CorrectionType } from '../types';
import { CorrectionScores as Scores, NESTED_SCORE_MULTIPLIER } from '../types';

const MAX_DEPTH = 100;

export interface CoercionContext {
  path: string[];
  corrections: Correction[];
  errors: CoercionError[];
  partial: boolean;
  unionVariantHint?: number;
  visited: Set<string>;
  depth: number;
}

export function createContext(
  partial: boolean,
  visited?: Set<string>,
  depth = 0,
): CoercionContext {
  return {
    path: [],
    corrections: [],
    errors: [],
    partial,
    visited: visited ?? new Set(),
    depth,
  };
}

export function isMaxDepthExceeded(ctx: CoercionContext): boolean {
  return ctx.depth >= MAX_DEPTH;
}

export function childContext(
  ctx: CoercionContext,
  key: string | number,
): CoercionContext {
  return {
    path: [...ctx.path, String(key)],
    corrections: [],
    errors: [],
    partial: ctx.partial,
    unionVariantHint: ctx.unionVariantHint,
    visited: ctx.visited,
    depth: ctx.depth + 1,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? v.toString() + 'n' : v,
    );
  } catch {
    return String(value);
  }
}

function getVisitedKey(schemaId: string, value: unknown): string {
  return `${schemaId}:${safeStringify(value)}`;
}

export function hasVisited(
  ctx: CoercionContext,
  schemaId: string,
  value: unknown,
): boolean {
  return ctx.visited.has(getVisitedKey(schemaId, value));
}

export function markVisited(
  ctx: CoercionContext,
  schemaId: string,
  value: unknown,
): void {
  ctx.visited.add(getVisitedKey(schemaId, value));
}

export function checkAndMarkVisited(
  ctx: CoercionContext,
  schemaId: string,
  value: unknown,
): boolean {
  const key = getVisitedKey(schemaId, value);
  if (ctx.visited.has(key)) return true;
  ctx.visited.add(key);
  return false;
}

export function addCorrection(
  ctx: CoercionContext,
  from: unknown,
  to: unknown,
  reason: string,
  type: CorrectionType,
): void {
  ctx.corrections.push({
    path: [...ctx.path],
    from,
    to,
    reason,
    type,
    score: Scores[type],
  });
}

export function addError(
  ctx: CoercionContext,
  expected: string,
  received: unknown,
  message: string,
): void {
  ctx.errors.push({ path: [...ctx.path], expected, received, message });
}

export function totalScore(corrections: Correction[]): number {
  return corrections.reduce((sum, c) => {
    const depth = c.path.length;
    const multiplier = Math.pow(NESTED_SCORE_MULTIPLIER, depth);
    return sum + c.score * multiplier;
  }, 0);
}
