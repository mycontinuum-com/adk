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
  Hooks,
  ModelConfig,
  ParallelMergeContext,
  Event,
  OutputConfig,
  ToolChoice,
} from '../types';
import type { Middleware } from '../middleware/types';
import type { ErrorHandler } from '../errors/types';

export interface AgentConfig<TOutput = unknown> {
  name: string;
  description?: string;
  model: ModelConfig;
  context: ContextRenderer[];
  tools?: Tool[];
  output?: OutputConfig<TOutput>;
  toolChoice?: ToolChoice;
  maxSteps?: number;
  hooks?: Hooks;
  middleware?: Middleware[];
  errorHandlers?: ErrorHandler[];
}

export interface SequenceConfig {
  name: string;
  description?: string;
  runnables: Runnable[];
}

export interface ParallelConfig {
  name: string;
  description?: string;
  runnables: Runnable[];
  merge?: (ctx: ParallelMergeContext) => Event[];
  failFast?: boolean;
  branchTimeout?: number;
  minSuccessful?: number;
}

export interface LoopConfig {
  name: string;
  description?: string;
  runnable: Runnable;
  maxIterations: number;
  while: (ctx: LoopContext) => boolean | Promise<boolean>;
  yields?: boolean;
}

export interface StepConfig {
  name: string;
  description?: string;
  execute: (ctx: StepContext) => StepResult | Promise<StepResult>;
}

/**
 * Create an LLM-powered agent that can reason and use tools.
 * @param config - Agent configuration
 * @param config.name - Unique identifier for the agent
 * @param config.model - LLM model configuration (use `openai()` or `gemini()`)
 * @param config.context - Array of context renderers that build model input
 * @param config.tools - Tools the agent can invoke
 * @param config.output - Structured output schema or state key
 * @param config.hooks - Lifecycle hooks (beforeAgent, afterModel, etc.)
 * @param config.maxSteps - Max reasoning iterations (default: 25)
 * @returns Agent runnable
 * @example
 * const assistant = agent({
 *   name: 'assistant',
 *   model: openai('gpt-4o-mini'),
 *   context: [injectSystemMessage('You are helpful.'), includeHistory()],
 *   tools: [myTool],
 * });
 */
export function agent<TOutput = unknown>(
  config: AgentConfig<TOutput>,
): Agent<TOutput> {
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
    middleware: config.middleware,
    errorHandlers: config.errorHandlers,
  };
}

/**
 * Execute runnables in order, passing the same session through each step.
 * @param config - Sequence configuration
 * @param config.name - Unique identifier for the sequence
 * @param config.runnables - Ordered array of runnables to execute
 * @returns Sequence runnable
 * @example
 * const pipeline = sequence({
 *   name: 'pipeline',
 *   runnables: [fetchStep, analyzerAgent, summarizerAgent],
 * });
 */
export function sequence(config: SequenceConfig): Sequence {
  return {
    kind: 'sequence',
    name: config.name,
    description: config.description,
    runnables: config.runnables,
  };
}

/**
 * Run runnables concurrently on cloned sessions, then merge events back.
 * @param config - Parallel configuration
 * @param config.name - Unique identifier for the parallel block
 * @param config.runnables - Array of runnables to execute concurrently
 * @param config.failFast - Stop all branches on first failure (default: false)
 * @param config.branchTimeout - Timeout per branch in ms
 * @param config.minSuccessful - Minimum branches that must succeed
 * @param config.merge - Custom merge function for branch results
 * @returns Parallel runnable
 * @example
 * const fanout = parallel({
 *   name: 'analysis',
 *   runnables: [sentimentAgent, factCheckAgent, summaryAgent],
 *   minSuccessful: 2,
 * });
 */
export function parallel(config: ParallelConfig): Parallel {
  return {
    kind: 'parallel',
    name: config.name,
    description: config.description,
    runnables: config.runnables,
    merge: config.merge,
    failFast: config.failFast,
    branchTimeout: config.branchTimeout,
    minSuccessful: config.minSuccessful,
  };
}

/**
 * Iterate a runnable until a condition is met or max iterations reached.
 * Set `yields: true` to pause between iterations for user input.
 * @param config - Loop configuration
 * @param config.name - Unique identifier for the loop
 * @param config.runnable - Runnable to execute each iteration
 * @param config.maxIterations - Maximum number of iterations
 * @param config.while - Condition function; loop continues while true
 * @param config.yields - Pause after each iteration for external input
 * @returns Loop runnable
 * @example
 * const chat = loop({
 *   name: 'chat',
 *   runnable: chatAgent,
 *   maxIterations: 100,
 *   yields: true,
 *   while: (ctx) => !ctx.state.get('exitRequested'),
 * });
 */
export function loop(config: LoopConfig): Loop {
  return {
    kind: 'loop',
    name: config.name,
    description: config.description,
    runnable: config.runnable,
    maxIterations: config.maxIterations,
    while: config.while,
    yields: config.yields,
  };
}

/**
 * Execute arbitrary TypeScript code as part of a workflow.
 *
 * Steps can:
 * - Execute code and return void (simple side effects)
 * - Return signals: `ctx.skip()`, `ctx.respond(text)`, `ctx.fail(msg)`, `ctx.complete(value)`
 * - Return a runnable to delegate execution to
 *
 * @param config - Step configuration
 * @param config.name - Unique identifier for the step
 * @param config.execute - Function to execute (receives StepContext)
 * @returns Step runnable
 * @example
 * // Simple side-effect step
 * const loadData = step({
 *   name: 'load_data',
 *   execute: async (ctx) => {
 *     const data = await fetchFromAPI();
 *     ctx.state.set('data', data);
 *   },
 * });
 *
 * // Gate/validation step with signals
 * const authGate = step({
 *   name: 'auth_gate',
 *   execute: (ctx) => {
 *     if (!ctx.state.get('authenticated')) {
 *       return ctx.fail('Not authenticated');
 *     }
 *   },
 * });
 *
 * // Routing step that delegates to another runnable
 * const priorityRouter = step({
 *   name: 'priority_router',
 *   execute: (ctx) => {
 *     const priority = ctx.state.get('priority');
 *     if (priority === 'urgent') return urgentAgent;
 *     if (priority === 'normal') return normalAgent;
 *     return ctx.respond('Unknown priority');
 *   },
 * });
 */
export function step(config: StepConfig): Step {
  return {
    kind: 'step',
    name: config.name,
    description: config.description,
    execute: config.execute,
  };
}
