import type {
  Agent,
  ToolResultEvent,
  ToolResultEventBase,
  ToolCallEvent,
  ToolYieldEvent,
  ToolInputEvent,
  FunctionToolHookContext,
  RunConfig,
  RunResult,
  RunResultBase,
  InvocationContext,
  ToolContext,
  AssistantEvent,
  StreamEvent,
  ErrorContext,
  InvocationOutcome,
  FunctionTool,
  Hooks,
  Runnable,
  HandoffTarget,
  TransferTarget,
  ParsedOutput,
} from '../types';
import { isFunctionTool } from '../core/tools';
import type { ComposedErrorHandler, ErrorRecovery } from '../errors/types';
import { OutputParseError } from '../errors/types';
import { createParser } from '../parser';
import { BaseSession, createEventId } from '../session';
import { createBoundStateAccessor } from '../context';
import { buildContext, createStartEvent, createEndEvent } from '../context';
import {
  withRetry,
  withInvocationBoundary,
  createInvocationId,
  isControlSignal,
  isRunnable,
  createOrchestrationContext,
  type InvocationBoundaryOptions,
  type ResumeContext,
} from '../core';
import type { AgentRunnerConfig } from './config';
import { DEFAULT_MAX_STEPS, MAX_TOOL_RETRY_ATTEMPTS } from '../core/constants';
import { composeMiddleware } from '../middleware';
import { composeErrorHandlers } from '../errors';

function enrichToolCallsWithYieldFlag(
  toolCalls: ToolCallEvent[],
  tools: FunctionTool[],
): void {
  const yieldingToolNames = new Set(
    tools.filter((t) => t.yieldSchema).map((t) => t.name),
  );
  for (const toolCall of toolCalls) {
    if (yieldingToolNames.has(toolCall.name)) {
      toolCall.yields = true;
    }
  }
}

export interface AgentResult extends Omit<RunResultBase, 'runnable'> {
  runnable: Agent;
  outcome: InvocationOutcome | null;
  yieldIndex: number;
  error?: string;
  output?: unknown;
  pendingCalls?: ToolCallEvent[];
  transfer?: TransferTarget;
}

async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function textToAssistantEvent(
  text: string,
  invocationId: string,
  agentName: string,
): AssistantEvent {
  return {
    id: createEventId(),
    type: 'assistant',
    createdAt: Date.now(),
    text,
    invocationId,
    agentName,
  };
}

function getLastAssistantText(session: BaseSession): string {
  const last = [...session.events]
    .reverse()
    .find((e) => e.type === 'assistant');
  return last?.type === 'assistant' ? last.text : '';
}

function createInvocationContext(
  config: AgentRunnerConfig,
  invocationId: string,
  session: BaseSession,
  agent: Agent,
  parentInvocationId?: string,
  onStream?: (event: StreamEvent) => void,
): InvocationContext {
  const orchestration = createOrchestrationContext({
    session,
    sessionService: config.sessionService,
    invocationId,
    subRunner: config.subRunner,
    onStream,
    signal: config.signal,
    channel: config.channel,
  });

  return {
    invocationId,
    parentInvocationId,
    runnable: agent,
    session,
    state: createBoundStateAccessor(session, invocationId),
    sessionService: config.sessionService,
    signal: config.signal,
    onStream,
    endInvocation: false,
    ...orchestration,
  };
}

function createToolContext(
  ctx: InvocationContext,
  call: ToolCallEvent,
  runnerConfig: AgentRunnerConfig,
  onStream?: (event: StreamEvent) => void,
): ToolContext {
  const orchestration = createOrchestrationContext({
    session: ctx.session as BaseSession,
    sessionService: runnerConfig.sessionService,
    invocationId: ctx.invocationId,
    subRunner: runnerConfig.subRunner,
    onStream,
    signal: runnerConfig.signal,
    callId: call.callId,
    channel: runnerConfig.channel,
  });

  return {
    ...ctx,
    state: createBoundStateAccessor(ctx.session, ctx.invocationId),
    callId: call.callId,
    toolName: call.name,
    args: call.args,
    subRunner: runnerConfig.subRunner,
    onStream,
    signal: runnerConfig.signal,
    ...orchestration,
  };
}

interface HandleErrorResult {
  recovery: ErrorRecovery;
  context: ErrorContext;
}

async function handleError(
  error: Error,
  ctx: InvocationContext,
  phase: ErrorContext['phase'],
  attempt: number,
  errorHandler: ComposedErrorHandler,
  options?: { toolName?: string; callId?: string; invocationStack?: string[] },
): Promise<HandleErrorResult> {
  const errorCtx: ErrorContext = {
    invocationId: ctx.invocationId,
    agent: ctx.runnable,
    phase,
    attempt,
    error,
    toolName: options?.toolName,
    callId: options?.callId,
    invocationStack: options?.invocationStack,
    timestamp: Date.now(),
  };

  const recovery = await errorHandler.handle(errorCtx);

  return { recovery, context: errorCtx };
}

async function applyAfterTool(
  agent: Agent,
  toolCtx: ToolContext,
  result: ToolResultEvent,
): Promise<ToolResultEvent> {
  return (await agent.hooks?.afterTool?.(toolCtx, result)) ?? result;
}

async function processResumedYields(
  agent: Agent,
  session: BaseSession,
  ctx: InvocationContext,
  runnerConfig: AgentRunnerConfig,
  onStream?: (event: StreamEvent) => void,
): Promise<void> {
  const toolYields = session.events.filter(
    (e): e is ToolYieldEvent => e.type === 'tool_yield',
  );

  for (const yieldEvent of toolYields) {
    const existingResult = session.events.find(
      (e): e is ToolResultEvent =>
        e.type === 'tool_result' && e.callId === yieldEvent.callId,
    );
    if (existingResult) continue;

    const inputEvent = session.events.find(
      (e): e is ToolInputEvent =>
        e.type === 'tool_input' && e.callId === yieldEvent.callId,
    );
    if (!inputEvent) continue;

    const toolCall = session.events.find(
      (e): e is ToolCallEvent =>
        e.type === 'tool_call' && e.callId === yieldEvent.callId,
    );
    if (!toolCall) continue;

    const tool = agent.tools
      .filter(isFunctionTool)
      .find((t) => t.name === yieldEvent.name);
    if (!tool) continue;

    const baseToolCtx = createToolContext(
      ctx,
      toolCall,
      runnerConfig,
      onStream,
    );
    const startTime = Date.now();

    let userInput = inputEvent.input;
    if (tool.yieldSchema) {
      const parsed = tool.yieldSchema.safeParse(userInput);
      if (!parsed.success) {
        const errorResult: ToolResultEvent = {
          id: createEventId(),
          type: 'tool_result',
          createdAt: Date.now(),
          callId: yieldEvent.callId,
          name: yieldEvent.name,
          error: `Invalid input: ${parsed.error.message}`,
          durationMs: Date.now() - startTime,
          invocationId: toolCall.invocationId,
          agentName: toolCall.agentName,
          providerContext: toolCall.providerContext,
        };
        await runnerConfig.sessionService.appendEvent(session, errorResult);
        onStream?.(errorResult);
        continue;
      }
      userInput = parsed.data;
    }

    const hookCtx: FunctionToolHookContext = {
      ...baseToolCtx,
      args: yieldEvent.preparedArgs,
      input: userInput,
    };

    let result: unknown;
    try {
      if (tool.execute) {
        result = await tool.execute(hookCtx);
      } else {
        result = userInput;
      }

      if (tool.finalize) {
        const finalizeCtx: FunctionToolHookContext = { ...hookCtx, result };
        const finalized = await tool.finalize(finalizeCtx);
        if (finalized !== undefined) {
          result = finalized;
        }
      }

      const resultEvent: ToolResultEvent = {
        id: createEventId(),
        type: 'tool_result',
        createdAt: Date.now(),
        callId: yieldEvent.callId,
        name: yieldEvent.name,
        result,
        durationMs: Date.now() - startTime,
        invocationId: toolCall.invocationId,
        agentName: toolCall.agentName,
        providerContext: toolCall.providerContext,
      };
      await runnerConfig.sessionService.appendEvent(session, resultEvent);
      onStream?.(resultEvent);
    } catch (error) {
      const errorResult: ToolResultEvent = {
        id: createEventId(),
        type: 'tool_result',
        createdAt: Date.now(),
        callId: yieldEvent.callId,
        name: yieldEvent.name,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        invocationId: toolCall.invocationId,
        agentName: toolCall.agentName,
        providerContext: toolCall.providerContext,
      };
      await runnerConfig.sessionService.appendEvent(session, errorResult);
      onStream?.(errorResult);
    }
  }
}

interface DelegateYieldInfo {
  invocationId: string;
  pendingCalls: ToolCallEvent[];
  awaitingInput?: boolean;
}

interface TransferInfo {
  agent: Runnable;
}

interface ExecuteToolResult {
  event: ToolResultEvent;
  abort?: boolean;
  delegateYielded?: DelegateYieldInfo;
  transfer?: TransferInfo;
}

async function executeToolCall(
  toolCall: ToolCallEvent,
  agent: Agent,
  toolCtx: ToolContext,
  errorHandler: ComposedErrorHandler,
): Promise<ExecuteToolResult> {
  const skipTool = await agent.hooks?.beforeTool?.(toolCtx, toolCall);
  if (skipTool) return { event: skipTool };

  const startTime = Date.now();
  const base: ToolResultEventBase = {
    id: createEventId(),
    type: 'tool_result',
    createdAt: startTime,
    callId: toolCall.callId,
    name: toolCall.name,
    providerContext: toolCall.providerContext,
    invocationId: toolCtx.invocationId,
    agentName: agent.name,
  };

  const tool = agent.tools
    .filter(isFunctionTool)
    .find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      event: await applyAfterTool(agent, toolCtx, {
        ...base,
        error: `Unknown tool: ${toolCall.name}`,
        durationMs: Date.now() - startTime,
      }),
    };
  }

  const parseResult = tool.schema.safeParse(toolCall.args);
  if (!parseResult.success) {
    return {
      event: await applyAfterTool(agent, toolCtx, {
        ...base,
        error: `Invalid arguments: ${parseResult.error.message}`,
        durationMs: Date.now() - startTime,
      }),
    };
  }

  let preparedArgs = parseResult.data;
  const hookCtx: FunctionToolHookContext = { ...toolCtx, args: preparedArgs };

  if (tool.prepare) {
    const prepared = await tool.prepare(hookCtx);
    if (prepared !== undefined) {
      preparedArgs = prepared;
      (hookCtx as { args: unknown }).args = preparedArgs;
    }
  }

  if (!tool.execute) {
    return {
      event: await applyAfterTool(agent, toolCtx, {
        ...base,
        error: `Tool '${tool.name}' has no execute function`,
        durationMs: Date.now() - startTime,
      }),
    };
  }

  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < MAX_TOOL_RETRY_ATTEMPTS) {
    attempt++;
    let timedOut = false;

    try {
      const executeTool = async () => {
        return await tool.execute!(hookCtx);
      };

      let execution = tool.retry
        ? withRetry(executeTool, tool.retry)
        : executeTool();

      if (tool.timeout) {
        execution = withToolTimeout(
          execution,
          tool.timeout,
          `Tool '${tool.name}' timed out after ${tool.timeout}ms`,
        );
      }

      let output = await execution;

      if (isControlSignal(output)) {
        return {
          event: await applyAfterTool(agent, toolCtx, {
            ...base,
            result: { yielded: true, invocationId: output.invocationId },
            durationMs: Date.now() - startTime,
            retryCount: attempt > 1 ? attempt : undefined,
          }),
          delegateYielded: {
            invocationId: output.invocationId,
            pendingCalls: output.pendingCalls,
            awaitingInput: output.awaitingInput,
          },
        };
      }

      if (isRunnable(output)) {
        return {
          event: await applyAfterTool(agent, toolCtx, {
            ...base,
            result: {
              transfer: true,
              agent: output.name,
            },
            durationMs: Date.now() - startTime,
            retryCount: attempt > 1 ? attempt : undefined,
          }),
          transfer: {
            agent: output,
          },
        };
      }

      if (tool.finalize) {
        const finalizeCtx: FunctionToolHookContext = {
          ...hookCtx,
          result: output,
        };
        const finalized = await tool.finalize(finalizeCtx);
        if (finalized !== undefined) {
          output = finalized;
        }
      }

      return {
        event: await applyAfterTool(agent, toolCtx, {
          ...base,
          result: output,
          durationMs: Date.now() - startTime,
          retryCount: attempt > 1 ? attempt : undefined,
        }),
      };
    } catch (error) {
      lastError = error as Error;
      const errorMessage = lastError.message;
      timedOut = errorMessage.includes('timed out');

      const { recovery } = await handleError(
        lastError,
        toolCtx,
        'tool',
        attempt,
        errorHandler,
        {
          toolName: toolCall.name,
          callId: toolCall.callId,
        },
      );

      switch (recovery.action) {
        case 'throw':
          throw lastError;

        case 'abort':
          return {
            event: await applyAfterTool(agent, toolCtx, {
              ...base,
              error: errorMessage,
              durationMs: Date.now() - startTime,
              retryCount: attempt > 1 ? attempt : undefined,
              timedOut: timedOut || undefined,
            }),
            abort: true,
          };

        case 'retry':
          if (recovery.delay) {
            await sleep(recovery.delay);
          }
          continue;

        case 'fallback':
          return {
            event: await applyAfterTool(agent, toolCtx, {
              ...base,
              result: recovery.result,
              durationMs: Date.now() - startTime,
              retryCount: attempt > 1 ? attempt : undefined,
            }),
          };

        case 'skip':
        case 'pass':
        default:
          return {
            event: await applyAfterTool(agent, toolCtx, {
              ...base,
              error: errorMessage,
              durationMs: Date.now() - startTime,
              retryCount: attempt > 1 ? attempt : undefined,
              timedOut: timedOut || undefined,
            }),
          };
      }
    }
  }

  return {
    event: await applyAfterTool(agent, toolCtx, {
      ...base,
      error: `Tool '${tool.name}' exceeded maximum retry attempts (${MAX_TOOL_RETRY_ATTEMPTS})`,
      durationMs: Date.now() - startTime,
      retryCount: attempt,
    }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ModelStepContext {
  agent: Agent;
  session: BaseSession;
  invocationId: string;
  iterations: number;
  ctx: InvocationContext;
  runnerConfig: AgentRunnerConfig;
  config: RunConfig | undefined;
  errorHandler: ComposedErrorHandler;
}

interface ModelStepOutcome {
  stepResult: import('../types').ModelStepResult | null;
  modelError?: string;
  shouldAbort: boolean;
  transfer?: TransferInfo;
}

async function* executeModelStep(
  mctx: ModelStepContext,
  renderCtx: import('../types').RenderContext,
  stepStartTime: number,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, ModelStepOutcome> {
  const {
    agent,
    runnerConfig,
    ctx,
    config,
    errorHandler,
    invocationId,
    iterations,
  } = mctx;
  const adapter = runnerConfig.getAdapter(agent.model.provider);

  const skipModel = await agent.hooks?.beforeModel?.(ctx, renderCtx);
  if (isRunnable(skipModel)) {
    return {
      stepResult: null,
      shouldAbort: false,
      transfer: { agent: skipModel },
    };
  }
  if (skipModel) {
    return { stepResult: skipModel, shouldAbort: false };
  }

  let modelAttempt = 0;
  let stepResult: import('../types').ModelStepResult | null = null;
  let modelError: string | undefined;
  let shouldAbort = false;

  while (stepResult === null && !shouldAbort) {
    modelAttempt++;
    try {
      const stream = adapter.step(renderCtx, agent.model, signal);
      let iterResult = await stream.next();
      while (!iterResult.done) {
        config?.onStream?.(iterResult.value);
        yield iterResult.value;
        iterResult = await stream.next();
      }
      stepResult = iterResult.value;
      if (!stepResult) {
        throw new Error('No step result from adapter');
      }
    } catch (err) {
      const { recovery } = await handleError(
        err as Error,
        ctx,
        'model',
        modelAttempt,
        errorHandler,
      );

      switch (recovery.action) {
        case 'throw': {
          const endEvent = createEndEvent({
            invocationId,
            agentName: agent.name,
            stepIndex: iterations,
            durationMs: Date.now() - stepStartTime,
            finishReason: 'error',
            error: (err as Error).message,
            modelName: agent.model.name,
          });
          await runnerConfig.sessionService.appendEvent(mctx.session, endEvent);
          config?.onStream?.(endEvent);
          yield endEvent;
          throw err;
        }
        case 'abort':
          shouldAbort = true;
          modelError = (err as Error).message;
          break;
        case 'retry':
          if (recovery.delay) {
            await sleep(recovery.delay);
          }
          break;
        case 'skip':
        case 'pass':
        default:
          modelError = (err as Error).message;
          stepResult = null;
          break;
      }
    }
  }

  return { stepResult, modelError, shouldAbort };
}

interface ToolExecutionResult {
  abort: boolean;
  delegateYieldInfo?: DelegateYieldInfo;
  transferInfo?: TransferInfo;
}

async function* processToolCalls(
  toolCalls: ToolCallEvent[],
  agent: Agent,
  ctx: InvocationContext,
  runnerConfig: AgentRunnerConfig,
  config: RunConfig | undefined,
  errorHandler: ComposedErrorHandler,
  session: BaseSession,
): AsyncGenerator<StreamEvent, ToolExecutionResult> {
  for (const toolCall of toolCalls) {
    const toolCtx = createToolContext(
      ctx,
      toolCall,
      runnerConfig,
      config?.onStream,
    );
    const {
      event: resultEvent,
      abort,
      delegateYielded,
      transfer,
    } = await executeToolCall(toolCall, agent, toolCtx, errorHandler);

    await runnerConfig.sessionService.appendEvent(session, resultEvent);
    config?.onStream?.(resultEvent);
    yield resultEvent;
    config?.onStep?.([resultEvent], session, agent);

    if (delegateYielded) {
      return { abort: false, delegateYieldInfo: delegateYielded };
    }
    if (transfer) {
      return { abort: false, transferInfo: transfer };
    }
    if (abort) {
      return { abort: true };
    }
  }

  return { abort: false };
}

interface ProcessedOutput {
  value: unknown;
  parsed?: ParsedOutput;
}

function processAgentOutput(
  agent: Agent,
  rawOutput: string,
  session: BaseSession,
  invocationId: string,
): ProcessedOutput {
  if (!agent.output || !rawOutput) {
    return { value: rawOutput || undefined };
  }

  const outputConfig = agent.output;

  if (typeof outputConfig === 'string') {
    session.setSessionState(outputConfig, rawOutput, invocationId);
    return { value: rawOutput };
  }

  if ('schema' in outputConfig) {
    const parser = createParser(outputConfig.schema);
    const result = parser.parse(rawOutput);

    if (result.success) {
      if (outputConfig.key) {
        session.setSessionState(outputConfig.key, result.value, invocationId);
      }
      return {
        value: result.value,
        parsed: {
          value: result.value,
          corrections: result.corrections,
          totalScore: result.totalScore,
        },
      };
    }

    throw new OutputParseError(
      rawOutput,
      outputConfig.schema,
      result.errors,
      result.partial,
      result.corrections,
    );
  }

  session.setSessionState(outputConfig.key, rawOutput, invocationId);
  return { value: rawOutput };
}

async function* executeAgentLoop(
  agent: Agent,
  session: BaseSession,
  config: RunConfig | undefined,
  signal: AbortSignal,
  invocationId: string,
  parentInvocationId: string | undefined,
  runnerConfig: AgentRunnerConfig,
  errorHandler: ComposedErrorHandler,
  initialEventCount: number,
  resumeContext?: ResumeContext,
): AsyncGenerator<StreamEvent, AgentResult> {
  const maxSteps = agent.maxSteps ?? DEFAULT_MAX_STEPS;
  const ctx = createInvocationContext(
    runnerConfig,
    invocationId,
    session,
    agent,
    parentInvocationId,
    config?.onStream,
  );

  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0;

  if (resumeContext) {
    await processResumedYields(
      agent,
      session,
      ctx,
      runnerConfig,
      config?.onStream,
    );
  }

  const skipAgent = await agent.hooks?.beforeAgent?.(ctx);
  if (isRunnable(skipAgent)) {
    return {
      session,
      iterations: 0,
      runnable: agent,
      stepEvents: [...session.events.slice(initialEventCount)],
      outcome: 'transferred',
      yieldIndex: currentYieldIndex,
      transfer: {
        invocationId: createInvocationId(),
        agent: skipAgent,
      },
    };
  }
  if (typeof skipAgent === 'string') {
    const skipEvent = textToAssistantEvent(skipAgent, invocationId, agent.name);
    await runnerConfig.sessionService.appendEvent(session, skipEvent);
    config?.onStep?.([skipEvent], session, agent);
    return {
      session,
      iterations: 0,
      runnable: agent,
      stepEvents: [...session.events.slice(initialEventCount)],
      outcome: 'completed',
      yieldIndex: currentYieldIndex,
    };
  }

  const mctx: ModelStepContext = {
    agent,
    session,
    invocationId,
    iterations: 0,
    ctx,
    runnerConfig,
    config,
    errorHandler,
  };

  let iterations = 0;
  let outcome: InvocationOutcome | null = 'completed';
  let error: string | undefined;

  try {
    while (iterations < maxSteps) {
      if (signal.aborted) {
        outcome = 'aborted';
        break;
      }
      if (ctx.endInvocation) break;
      iterations++;
      mctx.iterations = iterations;

      if (iterations >= maxSteps) {
        outcome = 'max_steps';
      }

      const renderCtx = buildContext(session, agent, invocationId);
      const stepStartTime = Date.now();

      const startEvent = createStartEvent(renderCtx, iterations, invocationId);
      await runnerConfig.sessionService.appendEvent(session, startEvent);
      config?.onStream?.(startEvent);
      yield startEvent;

      const { stepResult, modelError, shouldAbort, transfer } =
        yield* executeModelStep(mctx, renderCtx, stepStartTime, signal);

      if (transfer) {
        return {
          session,
          iterations,
          runnable: agent,
          stepEvents: [...session.events.slice(initialEventCount)],
          outcome: 'transferred',
          yieldIndex: currentYieldIndex,
          transfer: {
            invocationId: createInvocationId(),
            agent: transfer.agent,
          },
        };
      }

      if (shouldAbort) {
        outcome = 'aborted';
        const endEvent = createEndEvent({
          invocationId,
          agentName: agent.name,
          stepIndex: iterations,
          durationMs: Date.now() - stepStartTime,
          finishReason: 'error',
          error: modelError,
          modelName: agent.model.name,
        });
        await runnerConfig.sessionService.appendEvent(session, endEvent);
        config?.onStream?.(endEvent);
        yield endEvent;
        break;
      }

      if (!stepResult) {
        const endEvent = createEndEvent({
          invocationId,
          agentName: agent.name,
          stepIndex: iterations,
          durationMs: Date.now() - stepStartTime,
          finishReason: 'error',
          error: modelError,
          modelName: agent.model.name,
        });
        await runnerConfig.sessionService.appendEvent(session, endEvent);
        config?.onStream?.(endEvent);
        yield endEvent;
        continue;
      }

      let finalStepResult = stepResult;
      const modifiedResult = await agent.hooks?.afterModel?.(ctx, stepResult);
      if (isRunnable(modifiedResult)) {
        return {
          session,
          iterations,
          runnable: agent,
          stepEvents: [...session.events.slice(initialEventCount)],
          outcome: 'transferred',
          yieldIndex: currentYieldIndex,
          transfer: {
            invocationId: createInvocationId(),
            agent: modifiedResult,
          },
        };
      }
      if (modifiedResult) finalStepResult = modifiedResult;

      const endEvent = createEndEvent({
        invocationId,
        agentName: agent.name,
        stepIndex: iterations,
        durationMs: Date.now() - stepStartTime,
        usage: finalStepResult.usage,
        finishReason: finalStepResult.finishReason,
        modelName: agent.model.name,
      });
      await runnerConfig.sessionService.appendEvent(session, endEvent);
      config?.onStream?.(endEvent);
      yield endEvent;

      enrichToolCallsWithYieldFlag(
        finalStepResult.toolCalls,
        agent.tools.filter(isFunctionTool),
      );

      for (const event of finalStepResult.stepEvents) {
        await runnerConfig.sessionService.appendEvent(session, event);
        config?.onStream?.(event);
        yield event;
      }

      config?.onStep?.(finalStepResult.stepEvents, session, agent);

      if (finalStepResult.terminal) {
        break;
      }

      const pendingCalls = finalStepResult.toolCalls.filter(
        (tc) => tc.yields === true,
      );
      if (pendingCalls.length > 0) {
        const nonYieldingCalls: ToolCallEvent[] = stepResult.toolCalls.filter(
          (tc) => tc.yields !== true,
        );

        for (const toolCall of nonYieldingCalls) {
          const toolCtx = createToolContext(
            ctx,
            toolCall,
            runnerConfig,
            config?.onStream,
          );
          const { event: resultEvent } = await executeToolCall(
            toolCall,
            agent,
            toolCtx,
            errorHandler,
          );
          await runnerConfig.sessionService.appendEvent(session, resultEvent);
          config?.onStream?.(resultEvent);
          yield resultEvent;
          config?.onStep?.([resultEvent], session, agent);
        }
      }

      if (pendingCalls.length > 0) {
        for (const toolCall of pendingCalls) {
          const tool = agent.tools
            .filter(isFunctionTool)
            .find((t) => t.name === toolCall.name);
          if (!tool) continue;

          const baseToolCtx = createToolContext(
            ctx,
            toolCall,
            runnerConfig,
            config?.onStream,
          );

          const parseResult = tool.schema.safeParse(toolCall.args);
          if (!parseResult.success) continue;

          let preparedArgs = parseResult.data;
          if (tool.prepare) {
            const hookCtx: FunctionToolHookContext = {
              ...baseToolCtx,
              args: preparedArgs,
            };
            const prepared = await tool.prepare(hookCtx);
            if (prepared !== undefined) {
              preparedArgs = prepared;
            }
          }

          const yieldEvent: ToolYieldEvent = {
            id: createEventId(),
            type: 'tool_yield',
            createdAt: Date.now(),
            callId: toolCall.callId,
            name: toolCall.name,
            preparedArgs,
            invocationId: toolCall.invocationId,
            agentName: toolCall.agentName,
          };
          await runnerConfig.sessionService.appendEvent(session, yieldEvent);
          config?.onStream?.(yieldEvent);
        }

        return {
          runnable: agent,
          session,
          iterations,
          stepEvents: [...session.events.slice(initialEventCount)],
          outcome: 'yielded',
          yieldIndex: currentYieldIndex,
          pendingCalls,
        } satisfies AgentResult;
      }

      const toolResult = yield* processToolCalls(
        finalStepResult.toolCalls,
        agent,
        ctx,
        runnerConfig,
        config,
        errorHandler,
        session,
      );

      if (toolResult.delegateYieldInfo) {
        return {
          runnable: agent,
          session,
          iterations,
          stepEvents: [...session.events.slice(initialEventCount)],
          outcome: 'yielded',
          yieldIndex: currentYieldIndex,
          pendingCalls: toolResult.delegateYieldInfo.pendingCalls,
        } satisfies AgentResult;
      }

      if (toolResult.transferInfo) {
        return {
          runnable: agent,
          session,
          iterations,
          stepEvents: [...session.events.slice(initialEventCount)],
          outcome: 'transferred',
          yieldIndex: currentYieldIndex,
          transfer: {
            invocationId: createInvocationId(),
            agent: toolResult.transferInfo.agent,
          },
        } satisfies AgentResult;
      }

      if (toolResult.abort) {
        outcome = 'aborted';
        break;
      }
    }
  } catch (err) {
    outcome = 'error';
    error = err instanceof Error ? err.message : String(err);
    throw err;
  }

  const finalOutput = getLastAssistantText(session);
  const modifiedOutput = await agent.hooks?.afterAgent?.(ctx, finalOutput);
  const rawOutput = modifiedOutput ?? finalOutput;
  const processed = processAgentOutput(agent, rawOutput, session, invocationId);

  return {
    session,
    iterations,
    runnable: agent,
    stepEvents: [...session.events.slice(initialEventCount)],
    outcome,
    yieldIndex: currentYieldIndex,
    error,
    output: processed.value,
  };
}

export async function* runAgent(
  agent: Agent,
  session: BaseSession,
  config: RunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: AgentRunnerConfig,
  resumeContext?: ResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const initialEventCount = session.events.length;
  const invocationId = resumeContext?.invocationId ?? createInvocationId();

  const composedHooks: Hooks = composeMiddleware(
    runnerConfig.runnerMiddleware ?? [],
    agent.middleware ?? [],
    agent.hooks,
  );

  const composedErrorHandler = composeErrorHandlers(
    runnerConfig.runnerErrorHandlers ?? [],
    agent.errorHandlers ?? [],
  );

  const agentWithMiddleware: Agent = {
    ...agent,
    hooks: composedHooks,
  };

  const options: InvocationBoundaryOptions<AgentResult> = {
    onStream: config?.onStream,
    getIterations: (r) => r.iterations,
    getEndReason: (r) =>
      r.outcome === 'yielded' ? 'completed' : (r.outcome ?? 'completed'),
    getError: (r) => r.error,
    getHandoffTarget: (r): HandoffTarget | undefined =>
      r.transfer
        ? {
            invocationId: r.transfer.invocationId,
            agentName: r.transfer.agent.name,
          }
        : undefined,
    isYielded: (r) => r.outcome === 'yielded',
    getYieldInfo: (r) => ({
      pendingCallIds: r.pendingCalls?.map((c) => c.callId) ?? [],
      yieldIndex: r.yieldIndex,
    }),
    managed: runnerConfig.managed,
    handoffOrigin: runnerConfig.handoffOrigin,
    fingerprint: runnerConfig.fingerprint,
  };

  const result = yield* withInvocationBoundary(
    agentWithMiddleware,
    invocationId,
    parentInvocationId,
    session,
    runnerConfig.sessionService,
    executeAgentLoop(
      agentWithMiddleware,
      session,
      config,
      signal,
      invocationId,
      parentInvocationId,
      runnerConfig,
      composedErrorHandler,
      initialEventCount,
      resumeContext,
    ),
    options,
    resumeContext,
  );

  const stepEvents = [...session.events.slice(initialEventCount)];
  const base = {
    runnable: agent,
    session: result.session,
    iterations: result.iterations,
    stepEvents,
  };

  switch (result.outcome) {
    case 'yielded':
      return {
        ...base,
        status: 'yielded',
        pendingCalls: result.pendingCalls ?? [],
      };
    case 'completed':
      return {
        ...base,
        status: 'completed',
        output: result.output,
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        error: result.error ?? 'Unknown error',
      };
    case 'aborted':
      return { ...base, status: 'aborted' };
    case 'max_steps':
      return { ...base, status: 'max_steps' };
    case 'transferred':
      return {
        ...base,
        status: 'transferred',
        transfer: result.transfer!,
      };
    default:
      return {
        ...base,
        status: 'completed',
        output: result.output,
      };
  }
}
