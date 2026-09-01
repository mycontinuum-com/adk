import type { ModelConfig } from '../types/runnables'

/**
 * Maps tier-string names (e.g. 'opus', 'sonnet') to concrete ModelConfig instances.
 *
 * Required fields: - `default`: Used when a CC agent() call omits `model`. - `byTier`: Maps each
 * named tier to a ModelConfig. An unmapped tier name is a validation failure that stops the run
 * before any agent executes.
 *
 * This map is loader-local CC vocabulary and does NOT exist in the ADK core.
 */
export interface TierModelMap {
  /** ModelConfig used when model is omitted in a CC agent() call. */
  default: ModelConfig
  /**
   * Explicit tier-to-model mapping, e.g. `{ opus: claude('claude-opus-4-5'), sonnet:
   * openai('gpt-4o') }`.
   */
  byTier: Record<string, ModelConfig>
}

/**
 * A configurable node runner — the extension point that maps CC's unified `agent()` onto the ADK's
 * explicit LLM-vs-coding split.
 *
 * - Default (when `node` is omitted): uses `app.ask` — a no-tools, fresh-session LLM call.
 * - For build attractors: supply a coding node runner that creates a CodingAgent over a provisioned
 *   workspace.
 *
 * @param prompt - The task prompt string from the CC `agent(prompt, opts)` call.
 * @param opts - The options from the CC `agent()` call (label, phase, model, schema, etc.).
 * @param signal - AbortSignal from the enclosing workflow run.
 * @returns The validated object (or string) on success, or `null` on failure.
 */
export type NodeRunner = (
  prompt: string,
  opts: CCAgentOpts,
  signal?: AbortSignal,
) => Promise<unknown | null>

/**
 * The subset of CC `agent()` options recognized by the v1 loader. All other fields (isolation,
 * agentType, retries, timeoutMs) raise an unsupported-feature error.
 */
export interface CCAgentOpts {
  /** Optional human-readable label for this node invocation (used for metadata, not phase-emitting). */
  label?: string
  /** Phase grouping this node belongs to (used for metadata, not an additional phase-emitting call). */
  phase?: string
  /** Tier string from the CC file, e.g. 'opus' or 'sonnet'. Resolved through TierModelMap. */
  model?: string
  /** JSON Schema object literal describing the expected output shape. */
  schema?: Record<string, unknown>
  // Deferred features — presence triggers an unsupported-feature error:
  isolation?: unknown
  agentType?: unknown
  retries?: unknown
  timeoutMs?: unknown
}
