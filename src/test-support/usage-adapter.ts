import type { DecisionRequest } from '../types/decisions'
import type { ModelUsage } from '../types/events'
import type { ProviderModelConfig, RenderContext } from '../types/runnables'

import { MockAdapter } from '../testing/mock/adapter'

/** Usage each step and decision reports: 1M gpt-4o-mini input tokens, priced at $0.15. */
const STEP_USAGE: ModelUsage = {
  provider: 'openai',
  modelName: 'gpt-4o-mini',
  inputTokens: 1_000_000,
  outputTokens: 0,
}

/**
 * A mock adapter whose steps and decisions report `STEP_USAGE` while `reportUsage` is set. While
 * `stepGate` is set, each step waits for it, like a model call still running.
 */
export class UsageReportingAdapter extends MockAdapter {
  reportUsage = true
  stepGate: Promise<void> | undefined

  override async *step(ctx: RenderContext, config: ProviderModelConfig, signal?: AbortSignal) {
    await this.stepGate
    const stepped = yield* super.step(ctx, config, signal)
    return this.reportUsage ? { ...stepped, usage: STEP_USAGE } : stepped
  }

  override async decide(
    request: DecisionRequest,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ) {
    const decided = await super.decide(request, config, signal)
    return this.reportUsage ? { ...decided, usage: STEP_USAGE } : decided
  }
}
