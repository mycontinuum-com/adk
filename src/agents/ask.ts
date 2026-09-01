import type { z } from 'zod'

import type { ModelConfig } from '../types/runnables'

/**
 * Options for app.ask — a one-shot, no-tools, isolated (fresh BaseSession) typed LLM call.
 *
 * When `schema` is absent, the return type is `string` (the assistant text). When `schema` is
 * present, the return type is the inferred Zod output type.
 *
 * `retries` defaults to 2 when a schema is set and 0 when not. Only `OutputParseError` is retried;
 * provider/transport errors surface immediately.
 */
export interface AskOpts<T = string> {
  /**
   * The model to use for this call. Defaults to the app's configured default model. Omitting this
   * field MUST NOT fall back to a hardcoded or first-registered provider; it resolves to the app
   * default.
   */
  model?: ModelConfig
  /**
   * When supplied, the call returns the schema-validated output typed as `T`. When absent, returns
   * the assistant text as `string`.
   */
  schema?: z.ZodType<T>
  /** Optional system prompt prepended to this isolated call only. */
  system?: string
  /** AbortSignal threaded into the inner app.run call. */
  signal?: AbortSignal
  /**
   * Schema re-run budget. Defaults to 2 when a schema is set, 0 otherwise. Only `OutputParseError`
   * is retried; non-parse errors surface immediately.
   */
  retries?: number
}
