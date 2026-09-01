/**
 * Type-level assertions for app.ask — workflow.minimal-typed-run
 *
 * Compiled by `pnpm run typecheck`. Asserts the static return types are correct.
 */
import { expectTypeOf } from 'vitest'
import { z } from 'zod'

import type { AdkApp } from '../api/app'
import type { Step, StateSchema } from '../types'
import type { RunResult } from '../types/runtime'

import { adk } from '../api/app'

const app = adk()

// app.ask with no schema returns Promise<string>
expectTypeOf(app.ask('hello')).toEqualTypeOf<Promise<string>>()

// app.ask with schema returns the typed output
const schema = z.object({ title: z.string() })
expectTypeOf(app.ask('hello', { schema })).toEqualTypeOf<Promise<{ title: string }>>()

// app.step returns Step (is-a-step)
const wf: Step = app.step({ name: 'wf', execute: async () => {} })
expectTypeOf(wf).toMatchTypeOf<Step>()

// app.run(wf, 'go') returns StreamResult<RunResult> — confirm RunResult is the standard type
const streamResult = app.run(wf, 'go')
type AwaitedResult = Awaited<typeof streamResult>
expectTypeOf<AwaitedResult>().toMatchTypeOf<RunResult>()

// The coined symbols MUST NOT EXIST on AdkApp.
// Access the strongly-typed AdkApp directly — TypeScript will error if the property
// does not exist and @ts-expect-error suppresses the expected error, confirming absence.
declare const typedApp: AdkApp<StateSchema>
// @ts-expect-error — app.workflow does not exist on AdkApp
void typedApp.workflow
// @ts-expect-error — app.runWorkflow does not exist on AdkApp
void typedApp.runWorkflow
