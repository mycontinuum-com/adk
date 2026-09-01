/**
 * Type-level: workflow.no-shadow-shipped-surface
 *
 * Each shipped type has a single declaration site. fanout and app.parallel have different types.
 */
import { expectTypeOf } from 'vitest'

import type { AdkApp } from '../api/app'
import type { Runnable } from '../types'

import { fanout } from '../agents/fanout'

declare const app: AdkApp<any>

// app.parallel returns a Parallel (Runnable), not a Promise
const par = app.parallel({ name: 'p', runnables: [] as Runnable<any>[] })
expectTypeOf(par).toMatchTypeOf<{ kind: 'parallel' }>()

// fanout returns a Promise<Array<T | null>>
const fanoutResult = fanout<number>([])
expectTypeOf(fanoutResult).toEqualTypeOf<Promise<Array<number | null>>>()

// The two are NOT the same type
type ParallelType = typeof par
type FanoutType = typeof fanoutResult
// If they were the same, this would fail to compile
const _differentTypes: ParallelType extends FanoutType ? 'SAME' : 'DIFFERENT' = 'DIFFERENT'
