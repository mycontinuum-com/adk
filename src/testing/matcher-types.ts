/**
 * Matcher Types
 *
 * The matcher interface and its `vitest` module augmentation, kept in a module that imports NOTHING
 * at runtime. Two constraints meet here:
 *
 * 1. The augmentation must SHIP. It used to live in an ambient `vitest-matchers.d.ts`, and a `.d.ts`
 *    input is never re-emitted to `dist/` — so `dist/testing/index.d.ts` referenced it nowhere and
 *    a consumer writing `expect(events).toHaveToolCall(...)` got no types at all.
 * 2. The testing barrel must stay importable under plain node, where `import { expect } from 'vitest'`
 *    throws at module init (see barrel-imports-without-vitest.test.ts). So the barrel cannot reach
 *    `./matchers`, which does import vitest for real.
 *
 * Splitting the types out satisfies both: `index.ts` re-exports {@link AdkMatchers} from HERE,
 * which pulls `dist/testing/matcher-types.d.ts` — augmentation included — into a consumer's program
 * without putting `./matchers` in the barrel's static graph.
 *
 * @module
 */

import type { Event, StateScope } from '../types/events'

declare module 'vitest' {
  interface Assertion<T> extends AdkMatchers {}
  interface AsymmetricMatchersContaining extends AdkMatchers {}
}

/** The custom assertions {@link import('./matchers').setupAdkMatchers} registers with vitest. */
export interface AdkMatchers {
  toBeUuid(): void
  toHaveAssistantText(expected: string | RegExp): void
  toHaveToolCall(name: string, args?: Record<string, unknown>): void
  toHaveToolResult(name: string, result?: unknown): void
  toHaveEventSequence(types: string[]): void
  toHaveStatus(status: string): void
  toHaveState(scope: StateScope, key: string, value: unknown): void
  toHaveEvent(pattern: Partial<Event>): void
}
