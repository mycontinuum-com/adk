import { expectTypeOf } from 'vitest'

import type { Agent, ModelStepResult } from '../types'
import type { Hook } from './types'

type DuringModel = NonNullable<Hook['duringModel']>
type AnswersWhileTheModelRuns = () => Promise<ModelStepResult | void>
type AnswersBeforeTheModelStarts = () => ModelStepResult
type Transfers = () => Promise<Agent>

expectTypeOf<AnswersWhileTheModelRuns>().toExtend<DuringModel>()
expectTypeOf<AnswersBeforeTheModelStarts>().not.toExtend<DuringModel>()
expectTypeOf<Transfers>().not.toExtend<DuringModel>()
expectTypeOf<Parameters<DuringModel>[2]>().toEqualTypeOf<AbortSignal>()
