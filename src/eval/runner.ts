import type {
  Runnable,
  Tool,
  Agent,
  ToolHookContext,
  RunConfig,
  StreamResult,
} from '../types';
import { BaseRunner, type BaseRunnerConfig } from '../core';
import { BaseSession } from '../session';
import type { ToolMocks, MockToolContext } from './types';
import { EvalToolError } from './errors';

export type UnmockedToolBehavior = 'error' | 'throw' | 'warn' | 'passthrough';

export interface EvalRunnerConfig extends BaseRunnerConfig {
  toolMocks?: ToolMocks;
  strict?: boolean;
  onUnmockedTool?:
    | UnmockedToolBehavior
    | ((toolName: string, args: unknown) => void);
}

function isRealTool(value: unknown): value is Tool {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schema' in value &&
    'description' in value &&
    'execute' in value &&
    'name' in value
  );
}

interface InterceptionConfig {
  mocks: ToolMocks;
  strict: boolean;
  onUnmockedTool?:
    | UnmockedToolBehavior
    | ((toolName: string, args: unknown) => void);
  originalTools: Map<string, Tool>;
}

function createInterceptedTool<TInput, TOutput>(
  originalTool: Tool<TInput, TOutput>,
  config: InterceptionConfig,
): Tool<TInput, TOutput> {
  config.originalTools.set(originalTool.name, originalTool);

  return {
    ...originalTool,
    execute: async (ctx: ToolHookContext<TInput>): Promise<TOutput> => {
      const mockOrTool = config.mocks[originalTool.name];

      if (!mockOrTool) {
        return handleUnmockedTool(originalTool, ctx, config);
      }

      if (isRealTool(mockOrTool)) {
        return mockOrTool.execute?.(ctx) as Promise<TOutput>;
      }

      const mockCtx: MockToolContext = {
        callId: ctx.callId,
        toolName: ctx.toolName,
        invocationId: ctx.invocationId,
        state: ctx.state,
        now: () => Date.now(),
      };

      return mockOrTool.execute(ctx.args, mockCtx) as Promise<TOutput>;
    },
  };
}

function handleUnmockedTool<TInput, TOutput>(
  originalTool: Tool<TInput, TOutput>,
  ctx: ToolHookContext<TInput>,
  config: InterceptionConfig,
): Promise<TOutput> {
  const behavior = config.strict
    ? 'throw'
    : typeof config.onUnmockedTool === 'function'
      ? 'callback'
      : (config.onUnmockedTool ?? 'error');

  switch (behavior) {
    case 'throw':
      throw new EvalToolError(originalTool.name, ctx.args);

    case 'warn':
      console.warn(
        `[EvalRunner] Unmocked tool '${originalTool.name}' called with args:`,
        ctx.args,
      );
      return originalTool.execute?.(ctx) as Promise<TOutput>;

    case 'passthrough':
      return originalTool.execute?.(ctx) as Promise<TOutput>;

    case 'callback':
      if (typeof config.onUnmockedTool === 'function') {
        config.onUnmockedTool(originalTool.name, ctx.args);
      }
      throw new EvalToolError(originalTool.name, ctx.args);

    case 'error':
    default:
      throw new EvalToolError(originalTool.name, ctx.args);
  }
}

function interceptAgentTools(agent: Agent, config: InterceptionConfig): Agent {
  if (!agent.tools || agent.tools.length === 0) {
    return agent;
  }

  const interceptedTools = agent.tools.map((tool) =>
    createInterceptedTool(tool, config),
  );

  return {
    ...agent,
    tools: interceptedTools,
  };
}

function interceptRunnableTools(
  runnable: Runnable,
  config: InterceptionConfig,
): Runnable {
  switch (runnable.kind) {
    case 'agent':
      return interceptAgentTools(runnable, config);

    case 'sequence':
      return {
        ...runnable,
        runnables: runnable.runnables.map((r) =>
          interceptRunnableTools(r, config),
        ),
      };

    case 'parallel':
      return {
        ...runnable,
        runnables: runnable.runnables.map((r) =>
          interceptRunnableTools(r, config),
        ),
      };

    case 'loop':
      return {
        ...runnable,
        runnable: interceptRunnableTools(runnable.runnable, config),
      };

    case 'step':
      return runnable;

    default:
      return runnable;
  }
}

export class EvalRunner extends BaseRunner {
  private toolMocks: ToolMocks;
  private strict: boolean;
  private onUnmockedTool?:
    | UnmockedToolBehavior
    | ((toolName: string, args: unknown) => void);
  private originalTools: Map<string, Tool> = new Map();

  constructor(config?: EvalRunnerConfig) {
    super(config);
    this.toolMocks = config?.toolMocks ?? {};
    this.strict = config?.strict ?? false;
    this.onUnmockedTool = config?.onUnmockedTool;
  }

  run(
    runnable: Runnable,
    session: BaseSession,
    config?: RunConfig,
  ): StreamResult {
    const interceptionConfig: InterceptionConfig = {
      mocks: this.toolMocks,
      strict: this.strict,
      onUnmockedTool: this.onUnmockedTool,
      originalTools: this.originalTools,
    };

    const interceptedRunnable = interceptRunnableTools(
      runnable,
      interceptionConfig,
    );
    return super.run(interceptedRunnable, session, config);
  }

  setToolMocks(mocks: ToolMocks): void {
    this.toolMocks = mocks;
  }

  addToolMock(name: string, mock: ToolMocks[string]): void {
    this.toolMocks[name] = mock;
  }

  setStrict(strict: boolean): void {
    this.strict = strict;
  }

  getOriginalTools(): Map<string, Tool> {
    return this.originalTools;
  }
}

export function createEvalRunner(config?: EvalRunnerConfig): EvalRunner {
  return new EvalRunner(config);
}
