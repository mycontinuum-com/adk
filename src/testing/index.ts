export {
  runTest,
  user,
  model,
  input,
  result,
  type Step,
  type UserStep,
  type ModelStep,
  type InputStep,
  type ResultStep,
  type TestOptions,
  type TestResult,
  type MockResponseConfig,
} from './runTest'

// From './matcher-types', never './matchers': the latter imports vitest for real, and the barrel
// must stay loadable under plain node (barrel-imports-without-vitest.test.ts). This re-export is
// what pulls `matcher-types.d.ts` — and with it the `declare module 'vitest'` augmentation that
// types `expect(...).toHaveToolCall(...)` — into a consumer's program.
export type { AdkMatchers } from './matcher-types'

export { MockAdapter, type MockAdapterConfig } from './mock/adapter'
export { mockAgent, isMockAgent, getMockResponses } from './mock/agent'

/**
 * Vitest resolves LAZILY, at setup-call time — never at barrel import. Importing 'vitest' outside a
 * vitest worker throws ("Vitest failed to access its internal state"), and this barrel is also the
 * deterministic mock-run surface (`runTest`/`user`/`model`) that release harnesses drive under
 * plain node: the clinical-intelligence activation task errored on all 72 deterministic cases for
 * exactly this import (2026-08-02). Matcher users run inside vitest, where the lazy import is safe;
 * the matcher OBJECT stays in './matchers' for direct vitest-context imports.
 */
export async function setupAdkMatchers(): Promise<void> {
  const { setupAdkMatchers: setup } = await import('./matchers.js')
  setup()
}

export {
  createTestContext,
  testAgent,
  createTestSession,
  findEventsByType,
  findStreamEventsByType,
  getLastAssistantText,
  getToolCalls,
  getToolResults,
  collectStream,
  type TestContext,
} from './context'
