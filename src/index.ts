// App - primary API
export { adk } from './api'
export type {
  AdkConfig,
  AdkApp,
  RunOptions,
  AgentConfig,
  StepConfig,
  SequenceConfig,
  ParallelConfig,
  LoopConfig,
  ToolConfig,
  ContextNamespace,
  MCPNamespace,
} from './api'

// MCP (Model Context Protocol)
export type {
  MCPServer,
  MCPServerConfig,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
  MCPServerStatus,
  MCPServerState,
} from './mcp'

// Reusable runnable specs (advanced - prefer app.* methods)
export { spec } from './api'
export type {
  Spec,
  ToolSpec,
  StepSpec,
  ContextSpec,
  AgentSpec,
  SequenceSpec,
  ParallelSpec,
  LoopSpec,
  ToolsNamespace,
} from './api'

// Model providers — prefer sub-path imports for bundler compatibility:
//   import { openai } from '@animahealth/adk/openai'
//   import { gemini } from '@animahealth/adk/gemini'
//   import { claude } from '@animahealth/adk/claude'
// These re-exports still work but require the provider SDK as a peer dep:
/** @deprecated Import from `@animahealth/adk/openai` instead. */
export { openai } from './providers/models'
/** @deprecated Import from `@animahealth/adk/gemini` instead. */
export { gemini } from './providers/models'
/** @deprecated Import from `@animahealth/adk/claude` instead. */
export { claude } from './providers/models'

// Memory (standalone - not schema-dependent)
export {
  memory,
  pgvector,
  sqliteVec,
  inMemoryIndex,
  collectionSpec,
  normalizeFilter,
} from './memory'
// Memory index backends — prefer sub-path imports for bundler compatibility:
//   import { voyage } from '@animahealth/adk/voyage'
//   import { qdrant } from '@animahealth/adk/qdrant'
/** @deprecated Import from `@animahealth/adk/voyage` instead. */
export { voyage } from './memory/providers/voyage'
/** @deprecated Import from `@animahealth/adk/qdrant` instead. */
export { qdrant } from './memory/providers/qdrant'
export type {
  Memory,
  MemoryVariant,
  MemoryConfig,
  MetadataUpdate,
  EmbeddingModel,
  VoyageModel,
  QdrantConfig as QdrantIndexConfig,
  PgVectorConfig,
  Embedder,
  VectorIndex,
  VectorFilter,
  FilterInput,
  VectorCondition,
  Match,
  GetResult,
  SearchResult,
  SearchOptions,
  ScrollResult,
  SampleOptions,
  SampleResult,
  SlicedSampleResult,
  CollectionSpec,
  UpsertItem,
  SliceConfig,
  SlicedMemoryConfig,
  SlicedMemory,
  SliceAccessor,
  SlicedVariantAccessor,
  SlicedMatchUnion,
  SlicedSearchResult,
  SlicedGetUnion,
  PgPool,
} from './memory'

// Orchestration helpers (general — usable outside workflows)
export { fanout, type FanoutOptions } from './agents/fanout'
export type { AskOpts } from './agents/ask'

// Patterns
export { gated, cached, type CachedOptions } from './agents/patterns'

// Session persistence
export { sessionService } from './session/service'
export { inMemoryStore, InMemoryStore } from './session/memory'
// Stores with peer deps are available via subpath exports:
//   import { postgresStore } from '@animahealth/adk/stores/postgres'
//   import { dynamoStore } from '@animahealth/adk/stores/dynamodb'

// Hooks
export { composeHooks, loggingHook, metricsHook, cliHook } from './hook'
export type { LoggingHookOptions, MetricsHookOptions, Logger, CliHookOptions } from './hook'

export type { Transform, SimulateOptions, SimulateYieldContext } from './run'

// Handlers
export { turn } from './handler'
export type {
  HandlerInput,
  HandlerConfig,
  ResponseConfig,
  RestResponse,
  CommitStatus,
  TurnResult,
  TurnStream,
} from './handler'

// Error handling
export {
  retryHandler,
  rateLimitHandler,
  timeoutHandler,
  loggingHandler,
  defaultHandler,
  PipelineStructureChangedError,
  OutputParseError,
  ConflictError,
} from './errors'

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
} from './parser'
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
} from './parser'

// Schema helpers
export type { StateSchema, InferStateSchema, StateValues, ScopeState, TypedState } from './types'

// Session utilities (for advanced use)
export {
  snapshotAt,
  computeStateAtEvent,
  findEventIndex,
  findInvocationBoundary,
  SnapshotError,
  validateResumeState,
  assertReadyToResume,
  createEventId,
  createCallId,
} from './session'

// Core utilities (for advanced use)
export { isRunnable, isFunctionTool, isProviderTool, isMCPTool } from './core'

export {
  isSystemEvent,
  isUserEvent,
  isAssistantEvent,
  isThoughtEvent,
  isToolCallEvent,
  isToolYieldEvent,
  isToolInputEvent,
  isToolResultEvent,
  isStateChangeEvent,
  isInvocationStartEvent,
  isInvocationEndEvent,
  isInvocationYieldEvent,
  isInvocationResumeEvent,
  isModelStartEvent,
  isModelEndEvent,
  isArtifactUpdateEvent,
  isAnnotationEvent,
} from './types'

export type {
  TransformUserMessagesOptions,
  TransformStateAt,
  MessagePromptContext,
  EnrichmentPromptContext,
  HistoryScope,
  IncludeHistoryOptions,
  MessagePrompt,
  EnrichmentPrompt,
  Prompt,
} from './context'

// Types - Core interfaces
export type {
  EventType,
  InvocationEndReason,
  InvocationKind,
  SharedScope,
  StateScope,
  StateChangeSource,
  ProviderContext,
  EventBase,
  SystemEvent,
  UserEvent,
  AssistantEvent,
  ThoughtEvent,
  ToolCallEvent,
  ToolYieldEvent,
  ToolInputEvent,
  ToolResultEvent,
  StateChangeEvent,
  HandoffOrigin,
  HandoffTarget,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
  ModelStartEvent,
  ModelUsage,
  ModelEndEvent,
  ArtifactUpdateEvent,
  AnnotationEvent,
  ContextMessageSummary,
  ContextToolSummary,
  Event,
  ThoughtDeltaEvent,
  AssistantDeltaEvent,
  StreamEvent,
  ErrorContext,
  PartialOutputState,
  ParsedOutput,
  SessionStatus,
  Session,
  SessionInputNamespace,
  Input,
  MessageInput,
  ToolInput,
  MediaSource,
  MediaPart,
  StoredSession,
  CommitResult,
  SessionStore,
  SessionService,
  Sessions,
  CreateSessionOptions,
  RunnableKind,
  RetryConfig,
  VertexAIConfig,
  OpenAIModel,
  GeminiModel,
  ClaudeModel,
  ModelConfig,
  ProviderModelConfig,
  RealtimeModelConfig,
  Provider,
  ToolChoice,
  FunctionTool,
  ProviderTool,
  MCPTool,
  Tool,
  RenderContext,
  ContextRenderer,
  ModelStepResult,
  Hook,
  TurnContext,
  OutputMode,
  OutputSchemaConfig,
  OutputConfig,
  Agent,
  Sequence,
  ParallelMergeContext,
  Parallel,
  LoopContext,
  Loop,
  StepResult,
  StepContext,
  Step,
  Runnable,
  NoteOpts,
  OrchestrationContext,
  InvocationContext,
  ToolContext,
  ToolExecutionContext,
  HandoffInput,
  HandoffOptions,
  ModelAdapter,
  StreamResult,
  RunConfig,
  CostEstimate,
  UsageSummary,
  Output,
  RunResultBase,
  RunStatus,
  RunResult,
  TerminationReason,
  Runner,
  SpawnHandle,
  SpawnResult,
  DispatchHandle,
  SubRunResult,
  SubRunResultTransfer,
  CallResult,
  CallResultTransfer,
  TransferTarget,
} from './types'

export type { SessionSnapshot, InvocationBoundary } from './session'

// Experimental surfaces ship only behind their subpaths — never through this Core entry, where
// they would arrive with no stability badge (src/index.tier-boundary.test.ts is the gate):
//   import { runWorkflowFile } from '@animahealth/adk/workflow'
//   import { coding } from '@animahealth/adk/agents/coding'
// The knowledge module, gateway/process stores, artifact services, and channels are internal.
