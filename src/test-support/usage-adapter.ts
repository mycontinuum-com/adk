import type { ModelUsage } from '../types/events'
import type { ProviderModelConfig, RenderContext } from '../types/runnables'

import { MockAdapter } from '../testing/mock/adapter'

/** Usage each step reports: 1M gpt-4o-mini input tokens, priced at $0.15. */
const STEP_USAGE: ModelUsage = {
  provider: 'openai',
  modelName: 'gpt-4o-mini',
  inputTokens: 1_000_000,
  outputTokens: 0,
}

/** A mock adapter whose steps report `STEP_USAGE` while `reportUsage` is set. */
export class UsageReportingAdapter extends MockAdapter {
  reportUsage = true

  override async *step(ctx: RenderContext, config: ProviderModelConfig, signal?: AbortSignal) {
    const stepped = yield* super.step(ctx, config, signal)
    return this.reportUsage ? { ...stepped, usage: STEP_USAGE } : stepped
  }
}
