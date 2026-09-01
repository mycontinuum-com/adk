/**
 * Coding Agents
 *
 * This module provides coding agents that integrate external coding tools (Claude Code, etc.) into
 * the ADK execution pipeline.
 *
 * Coding agents implement both Runnable (.run()) and Tool (.execute()) interfaces, allowing them to
 * be used: - Standalone: `coder.run('Fix the bug')` - As tools: `app.agent({ tools: [coder] })` -
 * In sequences: `app.sequence({ agents: [planner, coder, reviewer] })`
 *
 * @module
 * @example
 *   ;```typescript
 *   import { createClaudeCodeAgent, coding } from '@animahealth/adk/agents/coding'
 *
 *   // Create a Claude Code agent
 *   const coder = createClaudeCodeAgent({
 *     workspace: '/path/to/repo',
 *     config: { permissionMode: 'acceptEdits' },
 *   })
 *
 *   // Run standalone
 *   const handle = coder.run('Fix the authentication bug')
 *   for await (const event of handle) {
 *     console.log(event.type)
 *   }
 *   const result = await handle
 *
 *   // Use as tool in an orchestrator
 *   const orchestrator = app.agent({
 *     tools: [coder],
 *     prompt: 'Delegate coding tasks as needed',
 *   })
 *
 *   // For testing, use mock
 *   const mockCoder = coding.mock({
 *     responses: [{ type: 'assistant', text: 'Done!' }],
 *   })
 *   ```
 */

import { createMockCodingAgent } from './mock'
import { createNoopTool, codingToolInputSchema } from './tool'

// ============================================================================
// Primary Types
// ============================================================================

export type {
  CodingAgent,
  CodingTask,
  CodingHandle,
  CodingResult,
  CodingInput,
  CodingToolInput,
  CodingOutput,
  CodingStatus,
  CodingError,
  CodingErrorCode,
  CodingToolOptions,
  MockCodingAgentOptions,
  MockResponse,
  MockArtifact,
} from './types'

export { codingToolInputSchema } from './types'

// ============================================================================
// Claude Code Agent
// ============================================================================

export { createClaudeCodeAgent, createClaudeCodeAgentWithSDK } from './claude-code'

export type {
  ClaudeCodeOptions,
  ClaudeCodeConfig,
  PermissionMode,
  ThinkingConfig,
  ProvisionContext,
} from './claude-code'

// ============================================================================
// Mock Agent
// ============================================================================

export { createMockCodingAgent } from './mock'

// ============================================================================
// Tool Utilities
// ============================================================================

export { createNoopTool } from './tool'

// ============================================================================
// Coding Node Seam (factory + orchestrator)
// ============================================================================

export { createCodingAgentFactory, createClaudeCodeFactory } from './factory'

export type {
  CodingAgentFactory,
  CodingNode,
  CodingNodeOutcome,
  CreateCodingAgentOptions,
  EnvironmentDelta,
  DeltaProbe,
  CodingFactoryOptions,
} from './factory'

export { runCodingNode } from './coding-node'

export type { RunCodingNodeOptions, CodingNodeResult } from './coding-node'

// ============================================================================
// Workspace Provisioner (isolation strategies for coding nodes)
// ============================================================================

export {
  createWorkspaceProvisioner,
  isIsolationStrategy,
  ISOLATION_STRATEGIES,
  UnknownIsolationStrategyError,
  WorkspaceProvisionError,
} from './workspace-provisioner'

export type {
  IsolationStrategy,
  ProvisionedWorkspace,
  WorkspaceProvisioner,
  ProvisionerBackends,
} from './workspace-provisioner'

// ============================================================================
// Coding Namespace
// ============================================================================

/**
 * Coding namespace - utilities for coding agents.
 *
 * Note: For the primary coding agents, use this subpath's exports: - `createClaudeCodeAgent()` -
 * Claude Code agent - `coding.mock()` - Mock agent for testing
 *
 * @example
 *   ;```typescript
 *   import { createClaudeCodeAgent, coding } from '@animahealth/adk/agents/coding';
 *
 *   // Production
 *   const coder = createClaudeCodeAgent({ workspace: '/repo' });
 *
 *   // Testing
 *   const mockCoder = coding.mock({ responses: [...] });
 *
 *   // No-op for stubs
 *   const noopTool = coding.noop();
 *   ```
 */
export const coding = {
  /**
   * Create a mock coding agent for testing. Emits predefined responses without making LLM API
   * calls.
   */
  mock: createMockCodingAgent,

  /** Create a no-op coding tool for testing. Immediately returns success without doing anything. */
  noop: createNoopTool,

  /** Zod schema for coding tool input validation. */
  schema: codingToolInputSchema,
}
