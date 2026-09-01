/**
 * Type-level assertion: RunOptions does NOT accept resume, background, or runId.
 *
 * These are v2-deferred options that MUST be absent from the v1 RunOptions type. Any attempt to
 * pass them through the typed API is a compile-time error. Runtime rejection (for callers that cast
 * to `any`) is enforced by the guard in executeRun.
 */
import type { RunOptions } from '../api/app'

// None of the v2 options appear in RunOptions
type RunOptionsKeys = keyof RunOptions

// These must be absent from RunOptions
type AssertNoResume = 'resume' extends RunOptionsKeys ? 'BAD' : 'OK'
type AssertNoBackground = 'background' extends RunOptionsKeys ? 'BAD' : 'OK'
type AssertNoRunId = 'runId' extends RunOptionsKeys ? 'BAD' : 'OK'

const _assertNoResume: AssertNoResume = 'OK'
const _assertNoBackground: AssertNoBackground = 'OK'
const _assertNoRunId: AssertNoRunId = 'OK'
