/**
 * Type-level: workflow.is-a-step — no coined surface symbols on AdkApp
 *
 * Compiled by `pnpm run typecheck`. These @ts-expect-error lines must compile without error,
 * proving the coined symbols are absent.
 */
import { expectTypeOf } from 'vitest'

import type { AdkApp } from '../api/app'
import type { Step, StateSchema } from '../types'
import type { RunResult } from '../types/runtime'

declare const app: AdkApp<StateSchema>

// A workflow IS a Step — app.run(step, input) returns StreamResult<RunResult>-typed stream
const wf: Step = app.step({ name: 'wf', execute: async () => {} })
const _stream = app.run(wf, 'go')
type _StreamAwaited = Awaited<typeof _stream>
// StreamResult when awaited should be compatible with RunResult
expectTypeOf<_StreamAwaited>().toMatchTypeOf<RunResult>()

// These coined symbols MUST NOT EXIST on AdkApp
// @ts-expect-error — app.workflow does not exist
void app.workflow
// @ts-expect-error — app.runWorkflow does not exist
void app.runWorkflow
