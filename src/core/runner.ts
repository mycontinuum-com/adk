import type {
  SessionService,
  Runnable,
  ModelAdapter,
  RunConfig,
  RunResult,
  Provider,
  StreamEvent,
  StreamResult,
  Runner,
  Session,
  SubRunConfig,
  HandoffOrigin,
  InvocationStartEvent,
  ModelEndEvent,
  UsageSummary,
  Event,
  User,
  YieldContext,
  YieldResponse,
  StateChanges,
  AssistantEvent,
} from '../types';
import { calculateCost } from '../providers/pricing';
import type { Middleware } from '../middleware/types';
import type { ErrorHandler } from '../errors/types';
import { BaseSession, InMemorySessionService } from '../session';
import { OpenAIAdapter } from '../providers/openai';
import { GeminiAdapter } from '../providers/gemini';
import { ClaudeAdapter } from '../providers/claude';
import { runAgent } from '../agents/reasoning';
import { runSequence, type SequenceResumeContext } from '../agents/sequential';
import { runParallel, type ParallelResumeContext } from '../agents/parallel';
import { runLoop, type LoopResumeContext } from '../agents/loop';
import { runStep, type StepResumeContext } from '../agents/step';
import type { WorkflowRunnerConfig } from '../agents/config';
import type { ResumeContext } from './invocation';
import {
  computeResumeContext,
  type RunnableResumeContext,
} from '../session/resume';
import { composeObservationHooks } from '../middleware';
import { computePipelineFingerprint } from '../session/fingerprint';
import { PipelineStructureChangedError } from '../errors/pipeline';
import type { EventChannel } from '../channels';
import { InMemoryChannel } from '../channels';

function validatePipelineFingerprint(
  session: BaseSession,
  currentFingerprint: string,
): void {
  const rootInvocationStart = session.events.find(
    (e): e is InvocationStartEvent =>
      e.type === 'invocation_start' && !e.parentInvocationId,
  );
  const storedFingerprint = rootInvocationStart?.fingerprint;

  if (storedFingerprint && storedFingerprint !== currentFingerprint) {
    throw new PipelineStructureChangedError(
      session.id,
      storedFingerprint,
      currentFingerprint,
    );
  }
}

function computeUsageSummary(
  events: readonly Event[],
): UsageSummary | undefined {
  const modelEndEvents = events.filter(
    (e): e is ModelEndEvent => e.type === 'model_end' && e.usage !== undefined,
  );

  if (modelEndEvents.length === 0) return undefined;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalReasoningTokens = 0;
  let totalCost = 0;
  let hasCostData = false;

  for (const event of modelEndEvents) {
    if (!event.usage) continue;
    totalInputTokens += event.usage.inputTokens;
    totalOutputTokens += event.usage.outputTokens;
    totalCachedTokens += event.usage.cachedTokens ?? 0;
    totalReasoningTokens += event.usage.reasoningTokens ?? 0;

    if (event.modelName) {
      const cost = calculateCost(event.usage, event.modelName);
      if (cost !== null) {
        totalCost += cost;
        hasCostData = true;
      }
    }
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCachedTokens,
    totalReasoningTokens,
    modelCalls: modelEndEvents.length,
    ...(hasCostData && {
      cost: {
        inputCost: 0,
        outputCost: 0,
        totalCost,
        currency: 'USD' as const,
      },
    }),
  };
}

function createStreamResult<T>(
  generator: AsyncGenerator<StreamEvent, T>,
  abortController: AbortController,
): StreamResult<T> {
  let consumed = false;
  let cachedPromise: Promise<T> | undefined;

  const consumeGenerator = async (): Promise<T> => {
    let iterResult = await generator.next();
    while (!iterResult.done) {
      iterResult = await generator.next();
    }
    return iterResult.value;
  };

  const getPromise = (): Promise<T> => {
    if (cachedPromise) return cachedPromise;
    consumed = true;
    cachedPromise = consumeGenerator();
    return cachedPromise;
  };

  const iterable: StreamResult<T> = {
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error('Stream already consumed');
      }
      consumed = true;
      return generator;
    },
    then(onFulfilled, onRejected) {
      return getPromise().then(onFulfilled, onRejected);
    },
    abort() {
      abortController.abort();
    },
  };

  return iterable;
}

function withTimeout<T>(
  generator: AsyncGenerator<StreamEvent, T>,
  timeoutMs: number,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
  };
  signal.addEventListener('abort', cleanup);

  return (async function* (): AsyncGenerator<StreamEvent, T> {
    try {
      let result = await Promise.race([generator.next(), timeoutPromise]);
      while (!result.done) {
        yield result.value;
        result = await Promise.race([generator.next(), timeoutPromise]);
      }
      cleanup();
      return result.value;
    } catch (error) {
      cleanup();
      throw error;
    }
  })();
}

export interface BaseRunnerConfig {
  sessionService?: SessionService;
  adapters?:
    | Map<Provider, ModelAdapter>
    | Partial<Record<Provider, ModelAdapter>>;
  middleware?: Middleware[];
  errorHandlers?: ErrorHandler[];
}

/**
 * Executes runnables (agents, sequences, loops, etc.) and manages their lifecycle.
 * Supports streaming, middleware, error handling, and yield/resume flows.
 */
export class BaseRunner implements Runner {
  private sessionService: SessionService;
  private adapters: Map<Provider, ModelAdapter>;
  readonly middleware: readonly Middleware[];
  readonly errorHandlers: readonly ErrorHandler[];

  constructor(config?: BaseRunnerConfig) {
    this.sessionService =
      config?.sessionService ?? new InMemorySessionService();
    this.middleware = config?.middleware ?? [];
    this.errorHandlers = config?.errorHandlers ?? [];

    const defaultAdapters = new Map<Provider, ModelAdapter>([
      ['openai', new OpenAIAdapter()],
      ['gemini', new GeminiAdapter()],
      ['claude', new ClaudeAdapter()],
    ]);

    if (config?.adapters) {
      if (config.adapters instanceof Map) {
        this.adapters = config.adapters;
      } else {
        this.adapters = new Map(defaultAdapters);
        for (const [provider, adapter] of Object.entries(config.adapters)) {
          if (adapter) {
            this.adapters.set(provider as Provider, adapter);
          }
        }
      }
    } else {
      this.adapters = defaultAdapters;
    }
  }

  private getAdapter(provider: Provider): ModelAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    return adapter;
  }

  run(
    runnable: Runnable,
    session: BaseSession,
    config?: RunConfig,
  ): StreamResult {
    const abortController = new AbortController();
    const eventChannel = new InMemoryChannel();

    const runnableMiddleware =
      runnable.kind === 'agent' ? (runnable.middleware ?? []) : [];
    const observationHooks = composeObservationHooks(
      this.middleware,
      runnableMiddleware,
    );

    const mergedOnStream = (event: StreamEvent) => {
      observationHooks.onStream?.(event);
      config?.onStream?.(event);
    };

    const mergedConfig: RunConfig = {
      ...config,
      onStream: mergedOnStream,
      onStep: (stepEvents, sess, r) => {
        observationHooks.onStep?.(stepEvents, sess, r);
        config?.onStep?.(stepEvents, sess, r);
      },
    };

    if (mergedConfig.onStream) {
      session.onStateChange((event) => {
        mergedConfig.onStream!(event);
      });
    }

    const resumeContext = computeResumeContext(session.events, runnable);
    const currentFingerprint = computePipelineFingerprint(runnable);

    if (resumeContext) {
      validatePipelineFingerprint(session, currentFingerprint);
    }

    const mainGenerator = this.execute(
      runnable,
      session,
      mergedConfig,
      abortController.signal,
      undefined,
      resumeContext,
      undefined,
      undefined,
      currentFingerprint,
      eventChannel,
    );

    eventChannel.registerGenerator('main', mainGenerator, true);

    abortController.signal.addEventListener('abort', () => {
      eventChannel.abort('Aborted');
    });

    let generator = this.wrapChannelWithResult(
      eventChannel.events(),
      session,
      runnable,
      config?.timeout,
      abortController.signal,
    );

    return createStreamResult(generator, abortController);
  }

  async runToChannel(
    runnable: Runnable,
    session: BaseSession,
    channel: EventChannel,
    config?: RunConfig & SubRunConfig,
  ): Promise<RunResult> {
    const mergedConfig: RunConfig = {
      ...config,
      onStream: (event) => {
        config?.onStream?.(event);
        channel.push(event);
      },
    };

    const resumeContext = computeResumeContext(session.events, runnable);
    const currentFingerprint = computePipelineFingerprint(runnable);

    const generator = this.execute(
      runnable,
      session,
      mergedConfig,
      new AbortController().signal,
      config?.id,
      resumeContext,
      config?.managed,
      undefined,
      currentFingerprint,
      channel,
    );

    if (channel.registerGenerator) {
      const { result, error } = await channel.registerGenerator(
        config?.id ?? 'runToChannel',
        generator,
      );
      if (error) throw error;
      return result as RunResult;
    }

    let iterResult = await generator.next();
    while (!iterResult.done) {
      channel.push(iterResult.value);
      iterResult = await generator.next();
    }

    return iterResult.value;
  }

  private async *wrapChannelWithResult(
    channelEvents: AsyncGenerator<StreamEvent>,
    session: BaseSession,
    runnable: Runnable,
    timeout?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, RunResult> {
    let generator: AsyncGenerator<StreamEvent> = channelEvents;

    if (timeout && signal) {
      generator = withTimeout(channelEvents, timeout, signal);
    }

    let result = await generator.next();
    while (!result.done) {
      yield result.value;
      result = await generator.next();
    }

    const channelResult = result.value;

    if (channelResult.thrownError) {
      throw channelResult.thrownError;
    }

    if (channelResult.aborted) {
      throw new Error(channelResult.abortReason ?? 'Aborted');
    }

    const mainResult = channelResult.mainResult;

    if (!mainResult) {
      return {
        session,
        iterations: 0,
        runnable,
        stepEvents: [],
        status: 'aborted',
      };
    }

    const base = {
      runnable,
      session,
      iterations: mainResult.iterations,
      stepEvents: [...session.events],
      usage: computeUsageSummary(session.events),
    };

    switch (mainResult.status) {
      case 'completed':
        return { ...base, status: 'completed', output: mainResult.output };
      case 'error':
        return {
          ...base,
          status: 'error',
          error: mainResult.error ?? 'Unknown error',
        };
      case 'yielded':
        return {
          ...base,
          status: 'yielded',
          pendingCalls: mainResult.pendingCalls ?? [],
          awaitingInput: mainResult.awaitingInput,
        };
      case 'max_steps':
        return { ...base, status: 'max_steps' };
      default:
        return { ...base, status: 'aborted' };
    }
  }

  private async *execute(
    runnable: Runnable,
    session: BaseSession,
    config: RunConfig | undefined,
    signal: AbortSignal,
    parentInvocationId?: string,
    resumeContext?: RunnableResumeContext,
    managed?: boolean,
    handoffOrigin?: HandoffOrigin,
    fingerprint?: string,
    channel?: EventChannel,
  ): AsyncGenerator<StreamEvent, RunResult> {
    const subRunner = {
      run: (
        subRunnable: Runnable,
        subParentInvocationId?: string,
        subConfig?: SubRunConfig,
      ) =>
        this.execute(
          subRunnable,
          session,
          config,
          signal,
          subParentInvocationId,
          subConfig?.id
            ? { invocationId: subConfig.id, yieldIndex: -1 }
            : undefined,
          subConfig?.managed,
          subConfig?.handoffOrigin,
          undefined,
          channel,
        ),
    };

    const workflowConfig: WorkflowRunnerConfig = {
      sessionService: this.sessionService,
      run: this.execute.bind(this),
      subRunner,
      onStream: config?.onStream,
      signal,
      fingerprint,
      channel,
    };

    switch (runnable.kind) {
      case 'agent': {
        const agentResult = yield* runAgent(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          {
            sessionService: this.sessionService,
            getAdapter: this.getAdapter.bind(this),
            runnerMiddleware: this.middleware,
            runnerErrorHandlers: this.errorHandlers,
            subRunner,
            runConfig: config,
            signal,
            managed,
            handoffOrigin,
            fingerprint,
            channel,
          },
          resumeContext as ResumeContext | undefined,
        );

        if (agentResult.status === 'transferred' && agentResult.transfer) {
          const { agent: targetAgent, invocationId: toInvocationId } =
            agentResult.transfer;

          const fromInvocationId =
            agentResult.stepEvents.find((e) => e.type === 'invocation_start')
              ?.invocationId ?? '';

          session.inheritTempState(fromInvocationId, toInvocationId);

          const transferOrigin: HandoffOrigin = {
            type: 'transfer',
            invocationId: fromInvocationId,
            agentName: runnable.name,
          };

          return yield* this.execute(
            targetAgent,
            session,
            config,
            signal,
            undefined,
            { invocationId: toInvocationId, yieldIndex: -1 },
            false,
            transferOrigin,
          );
        }

        return agentResult;
      }
      case 'sequence':
        return yield* runSequence(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as SequenceResumeContext | undefined,
        );
      case 'parallel':
        return yield* runParallel(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as ParallelResumeContext | undefined,
        );
      case 'loop':
        return yield* runLoop(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as LoopResumeContext | undefined,
        );
      case 'step':
        return yield* runStep(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as StepResumeContext | undefined,
        );
    }
  }

  /**
   * Quick way to run a runnable with a single message (creates session automatically).
   * @param runnable - Agent, sequence, parallel, loop, or step
   * @param message - Initial user message
   * @param options - Runner and run configuration
   * @returns StreamResult - async iterable of events, or await for final result
   * @example
   * const result = await BaseRunner.run(myAgent, 'Hello!');
   * console.log(result.session.events);
   */
  static run(
    runnable: Runnable,
    message: string,
    options?: {
      sessionService?: SessionService;
      adapters?: BaseRunnerConfig['adapters'];
      middleware?: BaseRunnerConfig['middleware'];
      errorHandlers?: BaseRunnerConfig['errorHandlers'];
      sessionId?: string;
      timeout?: number;
      onStep?: RunConfig['onStep'];
      onStream?: RunConfig['onStream'];
    },
  ): StreamResult {
    const runner = new BaseRunner({
      sessionService: options?.sessionService,
      adapters: options?.adapters,
      middleware: options?.middleware,
      errorHandlers: options?.errorHandlers,
    });
    const session = new BaseSession('default', {
      id: options?.sessionId,
    }).addMessage(message);

    return runner.run(runnable, session, {
      timeout: options?.timeout,
      onStep: options?.onStep,
      onStream: options?.onStream,
    });
  }

  async runWithUser(
    runnable: Runnable,
    session: BaseSession,
    config: RunConfig & { user: User },
  ): Promise<RunResult> {
    const maxIterations = config.maxYieldIterations ?? 100;
    let iterations = 0;

    let result = await this.run(runnable, session, config);

    while (result.status === 'yielded' && iterations < maxIterations) {
      iterations++;

      const yieldCtx = buildYieldContext(session, runnable, result);

      const response = await config.user.onYield(yieldCtx);

      applyYieldResponse(session, yieldCtx, response);

      result = await this.run(runnable, session, config);
    }

    if (iterations >= maxIterations && result.status === 'yielded') {
      return {
        ...result,
        status: 'error',
        error: `Max yield iterations (${maxIterations}) exceeded`,
      } as RunResult;
    }

    return result;
  }
}

function buildYieldContext(
  session: BaseSession,
  runnable: Runnable,
  result: RunResult,
): YieldContext {
  const pendingCalls = result.status === 'yielded' ? result.pendingCalls : [];
  const awaitingInput =
    result.status === 'yielded' ? result.awaitingInput : false;
  const yieldedInvocationId =
    result.status === 'yielded' ? result.yieldedInvocationId : undefined;

  const lastAssistantEvent = [...session.events]
    .reverse()
    .find((e): e is AssistantEvent => e.type === 'assistant');

  const agentName = runnable.kind === 'agent' ? runnable.name : 'unknown';

  const firstCall = pendingCalls[0];

  return {
    session,
    invocationId: yieldedInvocationId ?? '',
    agentName,
    yieldType: awaitingInput ? 'loop' : 'tool',
    toolName: firstCall?.name,
    callId: firstCall?.callId,
    args: firstCall?.args,
    pendingCalls,
    lastAssistantText: lastAssistantEvent?.text,
  };
}

function applyYieldResponse(
  session: BaseSession,
  ctx: YieldContext,
  response: YieldResponse,
): void {
  if (response.stateChanges) {
    applyStateChanges(session, response.stateChanges);
  }

  switch (response.type) {
    case 'tool_input':
      if (ctx.callId) {
        session.addToolInput(ctx.callId, response.input);
      }
      break;

    case 'tool_inputs':
      for (const [callId, input] of response.inputs) {
        session.addToolInput(callId, input);
      }
      break;

    case 'message':
      session.addMessage(response.text, ctx.invocationId);
      break;
  }
}

function applyStateChanges(session: BaseSession, changes: StateChanges): void {
  if (changes.session) {
    session.state.update(changes.session);
  }
  if (changes.user) {
    session.state.user.update(changes.user);
  }
  if (changes.patient) {
    session.state.patient.update(changes.patient);
  }
  if (changes.practice) {
    session.state.practice.update(changes.practice);
  }
}

export interface RunnerOptions {
  sessionService?: SessionService;
  adapters?: Partial<Record<Provider, ModelAdapter>>;
  middleware?: Middleware[];
  errorHandlers?: ErrorHandler[];
}

export interface FullRunConfig extends RunConfig {
  input?: string;
  session?: Session;
  runner?: Runner;
}

export function runner(options?: RunnerOptions): Runner {
  return new BaseRunner(options);
}

export function run(runnable: Runnable): StreamResult;
export function run(runnable: Runnable, input: string): StreamResult;
export function run(runnable: Runnable, config: FullRunConfig): StreamResult;
export function run(
  runnable: Runnable,
  inputOrConfig?: string | FullRunConfig,
): StreamResult {
  const config = typeof inputOrConfig === 'string' 
    ? { input: inputOrConfig } 
    : (inputOrConfig ?? {});
  const sess = (config.session ?? new BaseSession(runnable.name)) as BaseSession;
  if (config.input) sess.addMessage(config.input);
  const r = (config.runner ?? new BaseRunner()) as BaseRunner;
  return r.run(runnable, sess, config);
}
