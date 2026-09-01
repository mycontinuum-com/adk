/**
 * Coding Agent Factory (the fabric-injection seam)
 *
 * Reconciles the SHIPPED coding-agent surface (`createClaudeCodeAgent({ workspace }).run(task)`)
 * with the PROPOSAL's `.execute({ workspace, task })` outcome shape, WITHOUT changing the shipped
 * `CodingAgent` interface and without monkey-patching it.
 *
 * A `CodingAgentFactory.create({ workspace, signal })` returns a `CodingNode`: a thin handle whose
 * `run(task)` executes the underlying coding agent in the provisioned workspace and returns a
 * normalized `CodingNodeOutcome` carrying the ENVIRONMENT DELTA (workspace diff + command/test
 * result) alongside the raw `CodingResult`. The delta — never the agent's self-reported summary —
 * is what `./eval` scores (see ./coding-node).
 *
 * The seam is the single swap point: dropping in a second coding agent (Codex, a stub) drives the
 * IDENTICAL coding-node body. The Claude Agent SDK stays an OPTIONAL peer dep, loaded lazily by the
 * shipped `createClaudeCodeAgent` only when `run` actually executes.
 *
 * @module
 */

import type { CodingAgent, CodingResult, CodingTask } from './types'

import { createClaudeCodeAgent, type ClaudeCodeOptions } from './claude-code'

/** Options handed to {@link CodingAgentFactory.create}. */
export interface CreateCodingAgentOptions {
  /** Absolute path to the provisioned workspace the agent operates in. */
  workspace: string
  /** Abort signal threaded into the in-flight coder; aborting cancels the run. */
  signal?: AbortSignal
}

/**
 * The environment delta produced by a coding-node run: what the WORKSPACE shows, not what the agent
 * claims. This is the scoring surface — `summary` is carried for display only and MUST NOT feed a
 * score.
 */
export interface EnvironmentDelta {
  /** The workspace diff after the run (e.g. `git diff`). Empty string when nothing changed. */
  diff: string
  /** The result of the verification command/test run (e.g. test output). */
  commandResult: string
}

/**
 * Normalized outcome of a coding-node run. Aligns with the proposal's `{ workspace, task }` outcome
 * shape: it pins the environment `delta` as the scoring surface and keeps the raw shipped
 * `CodingResult` for provenance.
 */
export interface CodingNodeOutcome {
  /** The workspace the agent ran in. */
  workspace: string
  /** The task the agent was given. */
  task: string
  /** Environment delta (diff + command result) — the scoring surface. */
  delta: EnvironmentDelta
  /** The agent's self-reported summary text. For display ONLY; never scored. */
  summary?: string
  /** The raw shipped CodingResult (status, sessionId, usage, modifiedFiles, ...). */
  result: CodingResult
}

/**
 * A handle to a coding agent bound to a single provisioned workspace. Construction goes through
 * {@link CodingAgentFactory.create}; the node body never calls a coding-agent constructor
 * directly.
 */
export interface CodingNode {
  /** The workspace this node is bound to. */
  readonly workspace: string
  /**
   * Run the coding agent against the bound workspace and return the normalized outcome (delta + raw
   * result). Honors the factory-passed abort signal.
   */
  run(task: string | CodingTask): Promise<CodingNodeOutcome>
}

/**
 * The fabric-injection seam. `create({ workspace, signal })` constructs a {@link CodingNode} over a
 * provisioned workspace. Any coding agent (Claude Code today, Codex when implemented, a stub in
 * tests) plugs in here, and the same coding-node body drives all of them.
 */
export interface CodingAgentFactory {
  create(opts: CreateCodingAgentOptions): CodingNode
}

/**
 * How to derive the {@link EnvironmentDelta} for a finished run. A host supplies a real
 * implementation (e.g. `git diff` in the workspace + the test command's output). When omitted, the
 * delta is derived from the shipped `CodingResult` (modified files joined as a minimal diff, status
 * as the command result) so the seam is usable without a host probe — but a real coding workflow
 * SHOULD pass a probe so the diff and command result reflect the actual environment.
 */
export type DeltaProbe = (
  result: CodingResult,
  ctx: { workspace: string; task: string; signal?: AbortSignal },
) => Promise<EnvironmentDelta> | EnvironmentDelta

/** Options for {@link createCodingAgentFactory} / {@link createClaudeCodeFactory}. */
export interface CodingFactoryOptions {
  /**
   * Construct the underlying shipped CodingAgent for a workspace. Defaults to the shipped
   * `createClaudeCodeAgent` (lazy-loads the Claude Agent SDK only when `run` executes). Override to
   * inject Codex or a stub. The factory passes through `signal` into the run, not into
   * construction, matching the shipped `createClaudeCodeAgent({ workspace })` + `.run(task)`
   * surface.
   */
  build?: (opts: { workspace: string }) => CodingAgent
  /** How to derive the environment delta after a run. See {@link DeltaProbe}. */
  delta?: DeltaProbe
}

/** Default delta derivation when no host probe is supplied. */
function defaultDelta(result: CodingResult): EnvironmentDelta {
  const modified = result.output?.value?.modifiedFiles ?? []
  return {
    diff: modified.length > 0 ? modified.map((f) => `modified ${f}`).join('\n') : '',
    commandResult: `status: ${result.status}`,
  }
}

/**
 * Create a {@link CodingAgentFactory} over an arbitrary shipped-`CodingAgent` builder.
 *
 * Run order is the seam's contract: the caller PROVISIONS the workspace, then `create` CONSTRUCTS
 * the node, then `node.run` RUNS the agent. `create` does NOT provision; provisioning is the
 * WorkspaceProvisioner's job (see ./workspace-provisioner) and happens before `create` is called.
 */
export function createCodingAgentFactory(options: CodingFactoryOptions): CodingAgentFactory {
  const { build, delta } = options
  if (!build) {
    throw new Error(
      '[adk] createCodingAgentFactory: a `build` function is required (or use createClaudeCodeFactory).',
    )
  }
  const deriveDelta: DeltaProbe = delta ?? ((result) => defaultDelta(result))

  return {
    create({ workspace, signal }: CreateCodingAgentOptions): CodingNode {
      if (!workspace || workspace.trim() === '') {
        throw new Error(
          '[adk] CodingAgentFactory.create: a non-empty `workspace` path is required.',
        )
      }
      // Construct the shipped agent for this workspace. The shipped createClaudeCodeAgent lazy-loads
      // the Claude Agent SDK; construction here does NOT import the harness.
      const agent = build({ workspace })

      return {
        workspace,
        async run(task: string | CodingTask): Promise<CodingNodeOutcome> {
          const taskConfig: CodingTask = typeof task === 'string' ? { task } : task
          // Thread the factory-passed signal into the run unless the task already carries one.
          const handle = agent.run({ ...taskConfig, signal: taskConfig.signal ?? signal })
          const result = await handle
          const derived = await deriveDelta(result, {
            workspace,
            task: taskConfig.task,
            signal,
          })
          return {
            workspace,
            task: taskConfig.task,
            delta: derived,
            summary: result.output?.text,
            result,
          }
        },
      }
    },
  }
}

/**
 * Create a {@link CodingAgentFactory} backed by the shipped Claude Code coding agent.
 *
 * This is the production seam: `create({ workspace, signal })` adapts over `createClaudeCodeAgent({
 * workspace }).run(task)` and presents the proposal's outcome shape. The Claude Agent SDK is loaded
 * lazily by the shipped agent only when a node actually runs.
 *
 * @example
 *   ;```typescript
 *   import { createClaudeCodeFactory } from '@animahealth/adk/agents/coding'
 *
 *   const factory = createClaudeCodeFactory()
 *   const node = factory.create({ workspace: ws.path, signal })
 *   const outcome = await node.run('Implement the failing requirement; run the unit tests.')
 *   // score outcome.delta via ./eval — never outcome.summary
 *   ```
 */
export function createClaudeCodeFactory(
  options: {
    /** Extra ClaudeCode options (config, apiKey, provision) merged into every constructed agent. */
    claudeCode?: Omit<ClaudeCodeOptions, 'workspace'>
    /** How to derive the environment delta after a run. See {@link DeltaProbe}. */
    delta?: DeltaProbe
  } = {},
): CodingAgentFactory {
  return createCodingAgentFactory({
    // The shipped createClaudeCodeAgent does NOT import the Claude Agent SDK at module load — it
    // lazy-loads the harness inside its own getSDK() (a dynamic import) only when run() executes.
    // So a static import here keeps the harness lazy while constructing the agent eagerly.
    build: ({ workspace }) => createClaudeCodeAgent({ workspace, ...options.claudeCode }),
    delta: options.delta,
  })
}
