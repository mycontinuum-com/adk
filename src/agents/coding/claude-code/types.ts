/**
 * Claude Code Agent Types
 *
 * Type definitions for integrating the @anthropic-ai/claude-agent-sdk with the ADK's CodingAgent
 * interface.
 *
 * These types mirror the SDK's message structures and provide strong typing for the agent
 * implementation.
 *
 * @module
 */

/** Permission modes supported by Claude Code. Controls how tool executions are authorized. */
export type PermissionMode =
  | 'default' // Standard prompting for each tool use
  | 'acceptEdits' // Auto-approve file modifications
  | 'plan' // Planning mode without execution
  | 'dontAsk' // Deny unlisted tools; don't prompt
  | 'auto' // Model classifier approves or denies

/** Error types that can occur during assistant message processing. */
export type AssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown'

/** Result subtypes indicating how the query ended. */
export type ResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'

/** Rate limit status from the SDK. */
export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

/** Token usage statistics from the SDK. */
export interface SDKUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** Content block types in assistant messages. */
export type ContentBlockType = 'text' | 'tool_use' | 'thinking'

/** Text content block in assistant messages. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/** Tool use content block in assistant messages. */
export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** Thinking content block in assistant messages (extended thinking). */
export interface ThinkingContentBlock {
  type: 'thinking'
  thinking: string
}

/** Union of all content block types. */
export type ContentBlock = TextContentBlock | ToolUseContentBlock | ThinkingContentBlock

/** Tool result content in user messages. */
export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: 'text'; text: string }>
  is_error?: boolean
}

/** Text content in user messages. */
export interface TextContent {
  type: 'text'
  text: string
}

/** Content types for user messages. */
export type UserMessageContent =
  | string
  | TextContent
  | ToolResultContent
  | Array<TextContent | ToolResultContent>

/** The nested BetaMessage structure in SDKAssistantMessage. */
export interface BetaMessage {
  id: string
  type: 'message'
  role: 'assistant'
  content: ContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  usage: SDKUsage
}

/** SDK Assistant Message - contains model responses. */
export interface SDKAssistantMessage {
  type: 'assistant'
  message: BetaMessage
  uuid: string
  session_id: string
  error?: AssistantMessageError
}

/** SDK User Message - represents human or tool result input. */
export interface SDKUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: UserMessageContent
  }
  uuid: string
  session_id: string
}

/** Permission denial information. */
export interface PermissionDenial {
  tool_name: string
  tool_use_id: string
  tool_input: unknown
}

/** SDK Result Message - terminates queries with final stats. */
export interface SDKResultMessage {
  type: 'result'
  subtype: ResultSubtype
  result?: string
  total_cost_usd: number
  usage: SDKUsage
  errors?: Array<{ message: string }>
  permission_denials?: PermissionDenial[]
  session_id: string
}

/** SDK System Message - initialization data. */
export interface SDKSystemMessage {
  type: 'system'
  subtype: 'init' | 'status' | 'task_notification'
  tools?: string[]
  agents?: string[]
  mcp_servers?: string[]
  permissionMode?: PermissionMode
  session_id?: string
}

/** SDK Partial Assistant Message - streaming deltas. */
export interface SDKPartialAssistantMessage {
  type: 'partial_assistant'
  delta: {
    type: 'text_delta' | 'thinking_delta'
    text?: string
    thinking?: string
  }
  uuid: string
  session_id: string
}

/** SDK Tool Progress Message - progress during tool execution. */
export interface SDKToolProgressMessage {
  type: 'tool_progress'
  tool_use_id: string
  elapsed_ms: number
  progress?: string
}

/** SDK Rate Limit Event. */
export interface SDKRateLimitEvent {
  type: 'rate_limit'
  status: RateLimitStatus
  reset_at?: string
}

/** SDK Task Started Message - background task initiated. */
export interface SDKTaskStartedMessage {
  type: 'task_started'
  task_id: string
  task_type: string
}

/** SDK Task Progress Message - background task progress. */
export interface SDKTaskProgressMessage {
  type: 'task_progress'
  task_id: string
  summary?: string
}

/** SDK Task Notification Message - background task completion. */
export interface SDKTaskNotificationMessage {
  type: 'task_notification'
  task_id: string
  result?: unknown
}

/** Union of all SDK message types. */
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKToolProgressMessage
  | SDKRateLimitEvent
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskNotificationMessage

/** Configuration options specific to the Claude Code agent. */
export interface ClaudeCodeConfig {
  /**
   * Permission mode for tool authorization.
   *
   * @default 'acceptEdits'
   */
  permissionMode?: PermissionMode

  /**
   * Claude model to use.
   *
   * @default Uses Claude Code's default
   */
  model?: string

  /** Maximum agentic round-trips. */
  maxTurns?: number

  /** Maximum cost ceiling in USD. */
  maxBudgetUsd?: number

  /** Reasoning depth level. */
  effort?: 'low' | 'medium' | 'high' | 'max'

  /** Enable extended thinking. */
  thinking?: ThinkingConfig

  /** System prompt override or preset. */
  systemPrompt?: string

  /** Additional directories the agent can access. */
  additionalDirectories?: string[]

  /** Tool allowlist for auto-approval. */
  allowedTools?: string[]

  /** Tool denylist. */
  disallowedTools?: string[]

  /**
   * Whether to include partial streaming messages.
   *
   * @default true
   */
  includePartialMessages?: boolean

  /**
   * Enable session persistence to disk.
   *
   * @default true
   */
  persistSession?: boolean
}

/** Thinking configuration options. */
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' }

/** Session metadata returned by listSessions. */
export interface SessionMetadata {
  sessionId: string
  summary?: string
  lastModified: string
  customTitle?: string
  gitBranch?: string
}

/** Options for creating the Claude Code agent. */
export interface ClaudeCodeOptions {
  /**
   * Path to the workspace directory where the agent operates. The agent will have read/write access
   * to files within this directory.
   */
  workspace: string

  /** Configuration options for the agent. */
  config?: ClaudeCodeConfig

  /** API key for authentication. If not provided, uses ANTHROPIC_API_KEY environment variable. */
  apiKey?: string

  /**
   * Custom provision function for workspace setup. Called before each execution to set up .claude/
   * directory.
   */
  provision?: (workspace: string, context: ProvisionContext) => Promise<void>
}

/** Context provided to the provision function. */
export interface ProvisionContext {
  /** The task description. */
  task: string

  /** Session ID (if resuming). */
  sessionId?: string

  /** Agent configuration. */
  config: ClaudeCodeConfig
}
