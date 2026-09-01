/**
 * Claude Code Agent
 *
 * Production agent for integrating Claude Code into the ADK. Wraps the
 *
 * @module
 * @example
 *   ;```typescript
 *   import { claudeCode } from '@animahealth/adk'
 *
 *   const coder = claudeCode({
 *     workspace: '/path/to/repo',
 *     config: { permissionMode: 'acceptEdits' },
 *   })
 *
 *   // Run standalone
 *   const handle = coder.run('Fix the bug in auth.ts')
 *   for await (const event of handle) {
 *     console.log(event.type, event)
 *   }
 *   const result = await handle
 *
 *   // Use as tool
 *   const orchestrator = app.agent({
 *     tools: [coder],
 *     prompt: 'Delegate coding tasks as needed',
 *   })
 *   ```
 *
 * @anthropic-ai/claude-agent-sdk and maps its messages to ADK StreamEvents.
 */

export {
  createClaudeCodeAgent,
  createClaudeCodeAgentWithSDK,
  type ClaudeSDK,
  type SDKQueryOptions,
} from './agent'

export type {
  ClaudeCodeOptions,
  ClaudeCodeConfig,
  PermissionMode,
  ThinkingConfig,
  ProvisionContext,
  SessionMetadata,
  // SDK message types for advanced usage
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
} from './types'

export {
  mapSDKMessage,
  mapResultToCodingResult,
  createErrorResult,
  extractModifiedFile,
  type MapperContext,
} from './mappers'
