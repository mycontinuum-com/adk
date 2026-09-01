/**
 * Workspace Provisioner
 *
 * Isolation strategies for coding nodes. A coding node provisions a workspace before constructing a
 * CodingAgent over it; the workspace is disposed after the run (including on throw/abort) so
 * nothing leaks across a Bench sweep.
 *
 * Strategies:
 *
 * - `session`: an ephemeral session directory under the base path.
 * - `worktree`: a git worktree of the base repository.
 * - `sandbox`: an isolated sandbox (handed to a host-supplied sandbox backend).
 *
 * The interface is deliberately small: `provision(base, isolation) -> { path, dispose }`. The
 * default `createWorkspaceProvisioner` validates the isolation string BEFORE provisioning so an
 * unknown strategy fails fast with a clear error rather than silently falling back to a shared
 * directory.
 *
 * @module
 */

/** The isolation strategies a coding-node workspace can be provisioned with. */
export type IsolationStrategy = 'session' | 'worktree' | 'sandbox'

/** The set of valid isolation strategies, in priority order. */
export const ISOLATION_STRATEGIES: readonly IsolationStrategy[] = ['session', 'worktree', 'sandbox']

/** Type guard: is `value` one of the known isolation strategies? */
export function isIsolationStrategy(value: string): value is IsolationStrategy {
  return (ISOLATION_STRATEGIES as readonly string[]).includes(value)
}

/**
 * A provisioned workspace. The coding node runs against `path` and calls `dispose` exactly once
 * after the run — including when the coder throws or the run is aborted.
 */
export interface ProvisionedWorkspace {
  /** Absolute path to the provisioned workspace root. The coder's working directory. */
  path: string
  /**
   * Tear down the workspace. Invoked exactly once after the run (success, throw, or abort). MUST be
   * idempotent-safe to call once; the coding-node orchestrator guarantees a single call.
   */
  dispose: () => Promise<void> | void
  /** Which isolation strategy produced this workspace. */
  isolation: IsolationStrategy
}

/** Provisions isolated workspaces for coding nodes. The extension point for isolation strategies. */
export interface WorkspaceProvisioner {
  /**
   * Provision a workspace under `base` using the given isolation strategy.
   *
   * @param base - The base path (a repo root or a parent directory).
   * @param isolation - One of `session` | `worktree` | `sandbox`. An unknown value is rejected
   *   BEFORE provisioning with a clear error.
   * @returns A `{ path, dispose, isolation }` handle.
   */
  provision(base: string, isolation: string): Promise<ProvisionedWorkspace>
}

/**
 * Per-strategy provisioning backends. Each maps a base path to a concrete `{ path, dispose }`. The
 * default backends are pluggable so a host (Modal, Docker, plain git) can supply real
 * implementations; the orchestration contract (validate → provision → dispose-once) is owned here.
 */
export interface ProvisionerBackends {
  session?: (base: string) => Promise<ProvisionedWorkspace> | ProvisionedWorkspace
  worktree?: (base: string) => Promise<ProvisionedWorkspace> | ProvisionedWorkspace
  sandbox?: (base: string) => Promise<ProvisionedWorkspace> | ProvisionedWorkspace
}

/**
 * Error raised when an unknown isolation strategy is requested. Carries the offending value and the
 * set of strategies that ARE supported so the author can correct the call.
 */
export class UnknownIsolationStrategyError extends Error {
  constructor(public readonly isolation: string) {
    super(
      `unknown isolation strategy: '${isolation}'. Valid strategies: ${ISOLATION_STRATEGIES.join(
        ', ',
      )}`,
    )
    this.name = 'UnknownIsolationStrategyError'
  }
}

/**
 * Error raised when a workspace cannot be provisioned (the base path is missing or the requested
 * isolation cannot be materialized). The coding-node orchestrator treats this as a preflight
 * failure: it surfaces BEFORE any CodingAgent is constructed or run.
 */
export class WorkspaceProvisionError extends Error {
  constructor(
    message: string,
    public readonly isolation: string,
  ) {
    super(message)
    this.name = 'WorkspaceProvisionError'
  }
}

/**
 * Create a WorkspaceProvisioner.
 *
 * Validates the isolation string against the known strategies BEFORE invoking a backend, so an
 * unknown strategy fails fast (no partial provisioning, no shared-directory fallback). If a
 * strategy has no backend, a default backend is used that produces a distinct, kind-tagged path
 * under `base`.
 *
 * @example
 *   ;```typescript
 *   import { createWorkspaceProvisioner } from '@animahealth/adk/agents/coding'
 *
 *   const provisioner = createWorkspaceProvisioner()
 *   const ws = await provisioner.provision('/repo', 'worktree')
 *   try {
 *     // ...run a coding agent against ws.path...
 *   } finally {
 *     await ws.dispose()
 *   }
 *   ```
 */
export function createWorkspaceProvisioner(
  backends: ProvisionerBackends = {},
): WorkspaceProvisioner {
  return {
    async provision(base: string, isolation: string): Promise<ProvisionedWorkspace> {
      // Validate the strategy FIRST — an unknown strategy must fail before any provisioning work.
      if (!isIsolationStrategy(isolation)) {
        throw new UnknownIsolationStrategyError(isolation)
      }
      if (!base || base.trim() === '') {
        throw new WorkspaceProvisionError(
          `workspace could not be provisioned: base path is missing (isolation '${isolation}')`,
          isolation,
        )
      }

      const backend = backends[isolation]
      const ws = backend ? await backend(base) : defaultProvision(base, isolation)

      if (!ws || !ws.path || ws.path.trim() === '') {
        throw new WorkspaceProvisionError(
          `workspace could not be provisioned: backend for isolation '${isolation}' yielded no path`,
          isolation,
        )
      }
      return ws
    },
  }
}

/**
 * Default in-process provisioning: produce a distinct, kind-tagged path under `base` with a no-op
 * dispose. Real hosts override per-strategy via {@link ProvisionerBackends}; this default exists so
 * the orchestration contract is testable and so a strategy without a backend still yields a path
 * that matches its kind (a session dir, a worktree dir, a sandbox dir) rather than the base
 * itself.
 */
function defaultProvision(base: string, isolation: IsolationStrategy): ProvisionedWorkspace {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const sep = base.endsWith('/') ? '' : '/'
  const subdir =
    isolation === 'session'
      ? `.adk-session/${stamp}`
      : isolation === 'worktree'
        ? `.adk-worktrees/${stamp}`
        : `.adk-sandbox/${stamp}`
  return {
    path: `${base}${sep}${subdir}`,
    isolation,
    dispose: () => {
      /* no-op for the in-process default; real backends remove the directory / worktree / sandbox */
    },
  }
}
