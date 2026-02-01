// Execution
export { run, runner } from './core';
export type { RunnerOptions, FullRunConfig } from './core';
export { session } from './session';
export type { SessionOptions } from './session';
export { cli } from './cli';
export type { CLIOptions, CLIConfig, CLIHandle, DisplayMode } from './cli';

// Runnables
export { agent, step, sequence, parallel, loop } from './agents';
export { tool } from './core';

export { openai, gemini, claude } from './providers';

export {
  message,
  enrichment,
  injectSystemMessage,
  injectUserMessage,
  wrapUserMessages,
  enrichUserMessages,
  renderSchema,
  includeHistory,
  selectRecentEvents,
  pruneReasoning,
  pruneUserMessages,
  excludeChildInvocationInstructions,
  excludeChildInvocationEvents,
  limitTools,
  setToolChoice,
  buildContext,
  createRenderContext,
} from './context';

// Patterns
export { gated, cached, type CachedOptions } from './agents/patterns';

// Users
export {
  scriptedUser,
  humanUser,
  agentUser,
  AgentUserError,
  ScriptedUserExhaustedError,
  ScriptedUserNoHandlerError,
  type Bridge as UserBridge,
  type AgentUserConfig,
} from './users';

// Web
export {
  webSearch,
  fetchPage,
  fetchPages,
  SerperProvider,
  linkedInPipeline,
  closeBrowser,
} from './web';
export type {
  WebSearchConfig,
  FetchPageConfig,
  SearchProvider,
  SearchResult,
  FetchPageResult,
  FetchPipeline,
  ProxyConfig,
} from './web';

// Session services (for advanced use)
export {
  InMemorySessionService,
  LocalSessionService,
  BaseSession,
} from './session';
export type { BaseSessionOptions } from './session';

// Runner (for advanced use)
export { BaseRunner, type BaseRunnerConfig } from './core';

// Middleware
export {
  composeMiddleware,
  composeObservationHooks,
  loggingMiddleware,
  cliMiddleware,
} from './middleware';
export type {
  ComposedObservationHooks,
  CliMiddlewareOptions,
} from './middleware';

// Error handling
export {
  composeErrorHandlers,
  retryHandler,
  rateLimitHandler,
  timeoutHandler,
  loggingHandler,
  defaultHandler,
  PipelineStructureChangedError,
  OutputParseError,
} from './errors';

// Parsing
export {
  parse,
  parsePartial,
  createParser,
  parseJsonish,
  parsePartialJson,
  extractJsonFromText,
  coerce,
  coercePartial,
  createStreamParser,
  parseStreamChunks,
} from './parser';
export type {
  SchemaAwareParser,
  JsonishResult,
  StreamParser,
  StreamResult as ParserStreamResult,
  ParseResult,
  ParseError,
  ParserConfig,
  CoercionResult,
  CoercionError,
  Correction,
  StreamParseState,
} from './parser';

// Channels
export { InMemoryChannel } from './channels';
export type { EventChannel, ProducerResult, ChannelResult } from './channels';

// Schema helpers
export type { StateSchema, InferStateSchema, StateValues } from './types';
export { output } from './types';

// Provider adapters (for advanced use)
export { OpenAIAdapter, GeminiAdapter, ClaudeAdapter } from './providers';
export { getDefaultEndpoints, resolveModelName } from './providers';
export type { OpenAIEndpoint } from './providers';

// Session utilities (for advanced use)
export {
  createEventId,
  createCallId,
  computePipelineFingerprint,
  snapshotAt,
  computeStateAtEvent,
  computeAllStatesAtEvent,
  findEventIndex,
  findInvocationBoundary,
  SnapshotError,
  buildInvocationTree,
  computeResumeContext,
  validateResumeState,
  assertReadyToResume,
} from './session';

// CLI utilities
export { extractCurrentThoughtBlock } from './cli/event-display';
export { buildInvocationBlocks } from './cli/blocks';
export type { InvocationBlock } from './cli/blocks';

// Core utilities (for advanced use)
export {
  CONTROL,
  isControlSignal,
  isYieldSignal,
  isRunnable,
  signalYield,
  withRetry,
  withStreamRetry,
  withInvocationBoundary,
  createInvocationId,
} from './core';
export type {
  ControlSignal,
  YieldSignal,
  InvocationBoundaryOptions,
  YieldInfo,
  ResumeContext,
} from './core';

// Types - Configs
export type {
  AgentConfig,
  StepConfig,
  SequenceConfig,
  ParallelConfig,
  LoopConfig,
} from './agents';

export type {
  WrapUserMessagesOptions,
  MessagePromptContext,
  EnrichmentPromptContext,
  HistoryScope,
  IncludeHistoryOptions,
  MessagePrompt,
  EnrichmentPrompt,
  Prompt,
} from './context';

// Types - Core interfaces
export type {
  EventType,
  InvocationEndReason,
  InvocationKind,
  StateScope,
  ProviderContext,
  EventBase,
  SystemEvent,
  UserEvent,
  AssistantEvent,
  ThoughtEvent,
  ToolCallEvent,
  ToolResultEvent,
  StateChangeEvent,
  HandoffOrigin,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
  ModelStartEvent,
  ModelEndEvent,
  Event,
  ThoughtDeltaEvent,
  AssistantDeltaEvent,
  StreamEvent,
  ErrorContext,
  PartialOutputState,
  ParsedOutput,
  SessionStatus,
  StateAccessor,
  StateAccessorWithScopes,
  ScopedStateChanges,
  Session,
  SessionStoreSnapshot,
  SessionStore,
  SessionService,
  CreateSessionOptions,
  RunnableKind,
  RetryConfig,
  VertexAIConfig,
  OpenAIModel,
  GeminiModel,
  ClaudeModel,
  ModelConfig,
  Provider,
  ToolChoice,
  Tool,
  RenderContext,
  ContextRenderer,
  ModelStepResult,
  Hooks,
  OutputMode,
  OutputSchemaConfig,
  OutputConfig,
  Agent,
  Sequence,
  ParallelMergeContext,
  Parallel,
  LoopContext,
  Loop,
  StepSignal,
  StepResult,
  StepContext,
  Step,
  Runnable,
  InvocationContext,
  ToolContext,
  ToolHookContext,
  ModelAdapter,
  StreamResult,
  RunConfig,
  CostEstimate,
  UsageSummary,
  RunStatus,
  RunResult,
  Runner,
  SpawnHandle,
  DispatchHandle,
  CallResult,
  User,
  YieldContext,
  YieldResponse,
  StateChanges,
  CallContext,
  ScriptedUserConfig,
  HumanUserOptions,
  ToolHandler,
} from './types';

export type {
  InvocationNode,
  InvocationState,
  RunnableResumeContext,
  SpawnedTaskStatus,
  SessionSnapshot,
  InvocationBoundary,
} from './session';
