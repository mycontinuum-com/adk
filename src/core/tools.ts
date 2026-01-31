import { z } from 'zod';
import type {
  Tool,
  FunctionTool,
  FunctionToolHookContext,
  ProviderTool,
  RetryConfig,
  ToolCallEvent,
  Runnable,
} from '../types';

export const CONTROL = Symbol.for('adk.control');

export interface YieldSignal {
  readonly [CONTROL]: 'yield';
  invocationId: string;
  pendingCalls: ToolCallEvent[];
  awaitingInput?: boolean;
}

export type ControlSignal = YieldSignal;

export function isControlSignal(value: unknown): value is ControlSignal {
  return typeof value === 'object' && value !== null && CONTROL in value;
}

export function isYieldSignal(value: unknown): value is YieldSignal {
  return isControlSignal(value) && value[CONTROL] === 'yield';
}

export function isRunnable(value: unknown): value is Runnable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as Runnable).kind === 'string' &&
    ['agent', 'step', 'sequence', 'parallel', 'loop'].includes(
      (value as Runnable).kind,
    )
  );
}

export function signalYield(
  info: Omit<YieldSignal, typeof CONTROL>,
): YieldSignal {
  return { [CONTROL]: 'yield', ...info };
}

export function isProviderTool(tool: Tool): tool is ProviderTool {
  return 'type' in tool && typeof (tool as ProviderTool).type === 'string';
}

export function isFunctionTool(tool: Tool): tool is FunctionTool {
  return !isProviderTool(tool);
}

export function partitionTools(tools: Tool[]): {
  functionTools: FunctionTool[];
  providerTools: ProviderTool[];
} {
  const functionTools: FunctionTool[] = [];
  const providerTools: ProviderTool[] = [];
  for (const t of tools) {
    if (isProviderTool(t)) {
      providerTools.push(t);
    } else {
      functionTools.push(t);
    }
  }
  return { functionTools, providerTools };
}

/**
 * Define a tool that agents can use to interact with external systems.
 *
 * All hooks receive a single `ctx` parameter with typed access to:
 * - `ctx.args` - Tool arguments (typed from schema)
 * - `ctx.input` - User input after yield (typed from yieldSchema)
 * - `ctx.result` - Previous hook result (for finalize)
 * - `ctx.state` - Session state accessor
 * - `ctx.call/spawn/dispatch` - Agent orchestration
 *
 * Tool behavior is determined by which fields are provided:
 * - Standard tool: `execute` only - runs and returns result
 * - Gating tool: `yieldSchema` without `execute` - pauses for user input
 * - Confirming tool: `yieldSchema` with `execute` - pauses, then runs after user input
 *
 * @example
 * // Standard tool
 * const calc = tool({
 *   name: 'calculate',
 *   description: 'Evaluate math',
 *   schema: z.object({ expr: z.string() }),
 *   execute: (ctx) => ({ result: eval(ctx.args.expr) }),
 * });
 *
 * @example
 * // Gating tool - yields for user input (no execute)
 * const ask = tool({
 *   name: 'ask',
 *   description: 'Ask user a question',
 *   schema: z.object({ question: z.string() }),
 *   yieldSchema: z.object({ answer: z.string() }),
 *   finalize: (ctx) => ({
 *     question: ctx.args.question,
 *     answer: ctx.input!.answer,
 *   }),
 * });
 *
 * @example
 * // Confirming tool - yields, then executes after user approval
 * const approval = tool({
 *   name: 'request_approval',
 *   description: 'Request approval before action',
 *   schema: z.object({ action: z.string() }),
 *   yieldSchema: z.object({ approved: z.boolean() }),
 *   execute: (ctx) => {
 *     if (!ctx.input?.approved) {
 *       return { status: 'declined' };
 *     }
 *     return performAction(ctx.args.action);
 *   },
 * });
 */
export function tool<TInput, TOutput, TYield = never>(config: {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  yieldSchema?: z.ZodType<TYield>;
  prepare?: (
    ctx: FunctionToolHookContext<TInput>,
  ) => TInput | void | Promise<TInput | void>;
  execute?: (
    ctx: FunctionToolHookContext<TInput, TYield>,
  ) => TOutput | Promise<TOutput>;
  finalize?: (
    ctx: FunctionToolHookContext<TInput, TYield, TOutput>,
  ) => TOutput | void | Promise<TOutput | void>;
  timeout?: number;
  retry?: RetryConfig;
}): FunctionTool<TInput, TOutput, TYield> {
  if (!config.yieldSchema && !config.execute) {
    throw new Error(
      `Tool '${config.name}' must have either 'execute' or 'yieldSchema'`,
    );
  }
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    yieldSchema: config.yieldSchema,
    prepare: config.prepare,
    execute: config.execute,
    finalize: config.finalize,
    timeout: config.timeout,
    retry: config.retry,
  };
}
