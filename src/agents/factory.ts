import type { ErrorHandler } from '../errors/types'
import type { Event } from '../types/events'
import type {
  Agent,
  Sequence,
  Parallel,
  Loop,
  Step,
  LoopContext,
  StepContext,
  StepResult,
  Runnable,
  Tool,
  ContextRenderer,
  Hook,
  ModelConfig,
  ParallelMergeContext,
  OutputConfig,
  ToolChoice,
  AgentTimeouts,
} from '../types/runnables'
import type { StateSchema } from '../types/schema'

export interface AgentConfig<S extends StateSchema = StateSchema, TOutput = unknown> {
  name: string
  description?: string
  model: ModelConfig
  context: ContextRenderer<S>[]
  tools?: Tool<S>[]
  output?: OutputConfig<S, TOutput>
  toolChoice?: ToolChoice
  maxSteps?: number
  hooks?: Hook<S>[]
  errorHandlers?: ErrorHandler[]
  /**
   * After terminal model output, yield for user input instead of completing. Defaults to true for
   * realtime models.
   */
  yields?: boolean
  /** Safety cap on yield/resume cycles (default: 100). */
  maxTurns?: number
  /** Timeout configuration for inactivity and max duration. */
  timeouts?: AgentTimeouts
}

export interface SequenceConfig<S extends StateSchema = StateSchema> {
  name: string
  description?: string
  runnables: Runnable<S>[]
}

export interface ParallelConfig<S extends StateSchema = StateSchema> {
  name: string
  description?: string
  runnables: Runnable<S>[]
  merge?: (ctx: ParallelMergeContext<S>) => Event[]
  failFast?: boolean
  branchTimeout?: number
  minSuccessful?: number
}

export interface LoopConfig<S extends StateSchema = StateSchema> {
  name: string
  description?: string
  runnable: Runnable<S>
  maxIterations: number
  while: (ctx: LoopContext<S>) => boolean | Promise<boolean>
  yields?: boolean
}

export interface StepConfig<S extends StateSchema = StateSchema> {
  name: string
  description?: string
  execute: (ctx: StepContext<S>) => StepResult<S> | Promise<StepResult<S>>
}

/**
 * Create an LLM-powered agent that can reason and use tools.
 *
 * @example
 *   const assistant = agent({
 *     name: 'assistant',
 *     model: openai('gpt-4o-mini'),
 *     context: [injectSystemMessage('You are helpful.'), includeHistory()],
 *     tools: [myTool],
 *   })
 *
 * @param config - Agent configuration
 * @param config.name - Unique identifier for the agent
 * @param config.model - LLM model configuration (use `openai()` or `gemini()`)
 * @param config.context - Array of context renderers that build model input
 * @param config.tools - Tools the agent can invoke
 * @param config.output - Structured output schema or state key
 * @param config.hooks - Lifecycle hooks (beforeAgent, afterModel, etc.)
 * @param config.maxSteps - Max reasoning iterations (default: 25)
 * @returns Agent runnable
 */
export function agent<S extends StateSchema = StateSchema, TOutput = unknown>(
  config: AgentConfig<S, TOutput>,
): Agent<S, TOutput> {
  return {
    kind: 'agent',
    name: config.name,
    description: config.description,
    model: config.model,
    context: config.context,
    tools: config.tools ?? [],
    output: config.output,
    toolChoice: config.toolChoice,
    maxSteps: config.maxSteps,
    hooks: config.hooks,
    errorHandlers: config.errorHandlers,
    yields: config.yields,
    maxTurns: config.maxTurns,
    timeouts: config.timeouts,
  }
}

/**
 * Execute runnables in order, passing the same session through each step.
 *
 * @example
 *   const pipeline = sequence({
 *     name: 'pipeline',
 *     runnables: [fetchStep, analyzerAgent, summarizerAgent],
 *   })
 *
 * @param config - Sequence configuration
 * @param config.name - Unique identifier for the sequence
 * @param config.runnables - Ordered array of runnables to execute
 * @returns Sequence runnable
 */
export function sequence<S extends StateSchema = StateSchema>(
  config: SequenceConfig<S>,
): Sequence<S> {
  return {
    kind: 'sequence',
    name: config.name,
    description: config.description,
    runnables: config.runnables,
  }
}

/**
 * Run runnables concurrently on cloned sessions, then merge events back.
 *
 * @example
 *   const fanout = parallel({
 *     name: 'analysis',
 *     runnables: [sentimentAgent, factCheckAgent, summaryAgent],
 *     minSuccessful: 2,
 *   })
 *
 * @param config - Parallel configuration
 * @param config.name - Unique identifier for the parallel block
 * @param config.runnables - Array of runnables to execute concurrently
 * @param config.failFast - Stop all branches on first failure (default: false)
 * @param config.branchTimeout - Timeout per branch in ms
 * @param config.minSuccessful - Minimum branches that must succeed
 * @param config.merge - Custom merge function for branch results
 * @returns Parallel runnable
 */
export function parallel<S extends StateSchema = StateSchema>(
  config: ParallelConfig<S>,
): Parallel<S> {
  return {
    kind: 'parallel',
    name: config.name,
    description: config.description,
    runnables: config.runnables,
    merge: config.merge,
    failFast: config.failFast,
    branchTimeout: config.branchTimeout,
    minSuccessful: config.minSuccessful,
  }
}

/**
 * Iterate a runnable until a condition is met or max iterations reached. Set `yields: true` to
 * pause between iterations for user input.
 *
 * @example
 *   const chat = loop({
 *     name: 'chat',
 *     runnable: chatAgent,
 *     maxIterations: 100,
 *     yields: true,
 *     while: (ctx) => !ctx.state.exitRequested,
 *   })
 *
 * @param config - Loop configuration
 * @param config.name - Unique identifier for the loop
 * @param config.runnable - Runnable to execute each iteration
 * @param config.maxIterations - Maximum number of iterations
 * @param config.while - Condition function; loop continues while true
 * @param config.yields - Pause after each iteration for external input
 * @returns Loop runnable
 */
export function loop<S extends StateSchema = StateSchema>(config: LoopConfig<S>): Loop<S> {
  return {
    kind: 'loop',
    name: config.name,
    description: config.description,
    runnable: config.runnable,
    maxIterations: config.maxIterations,
    while: config.while,
    yields: config.yields,
  }
}

/**
 * Execute arbitrary TypeScript code as part of a workflow.
 *
 * Steps can: - Execute code and return void (simple side effects) - Use signals: `ctx.skip()`,
 * `ctx.respond(text)`, `ctx.fail(msg)` (throw internally, no return needed) - Return a runnable to
 * delegate execution to
 *
 * @example
 *   // Simple side-effect step
 *   const loadData = step({
 *     name: 'load_data',
 *     execute: async (ctx) => {
 *       ctx.state.data = await fetchFromAPI()
 *     },
 *   })
 *
 *   // Gate/validation step with signals
 *   const authGate = step({
 *     name: 'auth_gate',
 *     execute: (ctx) => {
 *       if (!ctx.state.authenticated) {
 *         ctx.fail('Not authenticated')
 *       }
 *     },
 *   })
 *
 *   // Routing step that delegates to another runnable
 *   const priorityRouter = step({
 *     name: 'priority_router',
 *     execute: (ctx) => {
 *       if (ctx.state.priority === 'urgent') return urgentAgent
 *       if (ctx.state.priority === 'normal') return normalAgent
 *       ctx.respond('Unknown priority')
 *     },
 *   })
 *
 * @param config - Step configuration
 * @param config.name - Unique identifier for the step
 * @param config.execute - Function to execute (receives StepContext)
 * @returns Step runnable
 */
export function step<S extends StateSchema = StateSchema>(config: StepConfig<S>): Step<S> {
  return {
    kind: 'step',
    name: config.name,
    description: config.description,
    execute: config.execute,
  }
}
