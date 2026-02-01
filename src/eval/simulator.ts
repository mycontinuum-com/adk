import type {
  Runnable,
  Session,
  Event,
  RunResult,
  ModelEndEvent,
  InvocationYieldEvent,
} from '../types';
import { BaseSession } from '../session';
import { EvalRunner } from './runner';
import { EvalSessionService } from './session';
import { createBridge, collectStateChanges, unwrapStateChange } from './bridge';
import { EvalUserAgentError } from './errors';
import type { Middleware } from '../middleware/types';
import type {
  EvalCase,
  EvalResult,
  EvalSuiteConfig,
  EvalSuiteResult,
  EvalStatus,
  EvalError,
  YieldInfo,
  StateChanges,
  Bridge,
  UserAgents,
  TerminateWhen,
  TerminationReason,
  Metric,
  MetricResult,
} from './types';

interface EvalContext {
  evalCase: EvalCase;
  runner: EvalRunner;
  mainSession: Session;
  userAgentSession: Session;
  bridge: Required<Bridge>;
  sessionService: EvalSessionService;
  middleware?: Middleware[];
  state: {
    turns: number;
    startTime: number;
    tokenUsage: { input: number; output: number };
  };
}

type StepOutcome = 'completed' | 'error' | 'terminated';

type StepResult =
  | { done: false }
  | { done: true; outcome: 'completed'; output?: unknown }
  | { done: true; outcome: 'error'; error: string }
  | { done: true; outcome: 'terminated'; reason: TerminationReason };

function matchesStateCondition(
  session: Session,
  condition: Record<string, unknown>,
): boolean {
  for (const [scope, conditions] of Object.entries(condition)) {
    if (
      scope !== 'session' &&
      scope !== 'user' &&
      scope !== 'patient' &&
      scope !== 'practice'
    ) {
      continue;
    }

    const stateAccessor =
      scope === 'session' ? session.state : session.state[scope];
    const conditionObj = conditions as Record<string, unknown>;

    for (const [key, expected] of Object.entries(conditionObj)) {
      const value = stateAccessor[key];

      if (typeof expected === 'object' && expected !== null) {
        const op = expected as Record<string, unknown>;
        if ('$exists' in op) {
          const exists = value !== undefined;
          if (op.$exists !== exists) return false;
        } else if ('$eq' in op) {
          if (value !== op.$eq) return false;
        } else if ('$ne' in op) {
          if (value === op.$ne) return false;
        } else if (!deepEqual(value, expected)) {
          return false;
        }
      } else if (value !== expected) {
        return false;
      }
    }
  }

  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }

  return true;
}

function checkTermination(
  session: Session,
  state: EvalContext['state'],
  terminateWhen?: TerminateWhen,
): {
  terminated: boolean;
  reason?: TerminationReason;
} {
  if (!terminateWhen) {
    return { terminated: false };
  }

  if (
    terminateWhen.maxTurns !== undefined &&
    state.turns >= terminateWhen.maxTurns
  ) {
    return { terminated: true, reason: 'maxTurns' };
  }

  if (terminateWhen.maxDuration !== undefined) {
    const elapsed = Date.now() - state.startTime;
    if (elapsed >= terminateWhen.maxDuration) {
      return { terminated: true, reason: 'maxDuration' };
    }
  }

  if (terminateWhen.stateMatches) {
    if (matchesStateCondition(session, terminateWhen.stateMatches)) {
      return { terminated: true, reason: 'stateMatches' };
    }
  }

  return { terminated: false };
}

function extractTokenUsage(events: readonly Event[]): {
  input: number;
  output: number;
} {
  let input = 0;
  let output = 0;

  for (const event of events) {
    if (event.type === 'model_end') {
      const modelEnd = event as ModelEndEvent;
      if (modelEnd.usage) {
        input += modelEnd.usage.inputTokens;
        output += modelEnd.usage.outputTokens;
      }
    }
  }

  return { input, output };
}

function getYieldInfo(result: RunResult): YieldInfo | null {
  if (result.status !== 'yielded') {
    return null;
  }

  if (result.pendingCalls && result.pendingCalls.length > 0) {
    const call = result.pendingCalls[0];
    return {
      type: 'tool',
      invocationId: call.invocationId,
      toolName: call.name,
      callId: call.callId,
      args: call.args,
    };
  }

  if (result.awaitingInput) {
    const yieldEvent = [...result.session.events]
      .reverse()
      .find((e): e is InvocationYieldEvent => e.type === 'invocation_yield');

    return {
      type: 'loop',
      invocationId: yieldEvent?.invocationId ?? '',
      awaitingInput: true,
    };
  }

  return null;
}

async function runUserAgent(
  userAgent: Runnable,
  userAgentSession: Session,
  prompt: string,
  sessionService: EvalSessionService,
  middleware?: Middleware[],
): Promise<{ output: unknown; stateChanges: StateChanges }> {
  userAgentSession.addMessage(prompt);

  const runner = new EvalRunner({ sessionService, middleware });
  const result = await runner.run(userAgent, userAgentSession as BaseSession);

  const output = result.status === 'completed' ? result.output : undefined;

  const toolResultEvents = userAgentSession.events.filter(
    (e) => e.type === 'tool_result',
  );
  const results = toolResultEvents.map(
    (e) => (e as { result?: unknown }).result,
  );
  const stateChanges = collectStateChanges(results);

  return { output, stateChanges };
}

async function handleYield(
  mainSession: Session,
  userAgentSession: Session,
  yieldInfo: YieldInfo,
  userAgents: UserAgents,
  bridge: Required<Bridge>,
  sessionService: EvalSessionService,
  middleware?: Middleware[],
): Promise<void> {
  let userAgent: Runnable | undefined;

  if (yieldInfo.type === 'loop') {
    userAgent = userAgents.loop;
    if (!userAgent) {
      throw new EvalUserAgentError('loop');
    }
  } else {
    userAgent = userAgents.tools?.[yieldInfo.toolName!];
    if (!userAgent) {
      throw new EvalUserAgentError('tool', yieldInfo.toolName, yieldInfo.args);
    }
  }

  const prompt = await bridge.formatPrompt(mainSession, yieldInfo);

  const { output, stateChanges } = await runUserAgent(
    userAgent,
    userAgentSession,
    prompt,
    sessionService,
    middleware,
  );

  if (Object.keys(stateChanges).length > 0) {
    if (stateChanges.session) {
      mainSession.state.update(stateChanges.session);
    }
    if (stateChanges.user) {
      mainSession.state.user.update(stateChanges.user);
    }
    if (stateChanges.patient) {
      mainSession.state.patient.update(stateChanges.patient);
    }
    if (stateChanges.practice) {
      mainSession.state.practice.update(stateChanges.practice);
    }
  }

  const response = await bridge.formatResponse(
    output,
    userAgentSession,
    yieldInfo,
  );
  const unwrappedResponse = unwrapStateChange(response);

  if (yieldInfo.type === 'loop') {
    mainSession.addMessage(
      String(unwrappedResponse ?? ''),
      yieldInfo.invocationId,
    );
  } else if (yieldInfo.callId) {
    mainSession.addToolResult(yieldInfo.callId, unwrappedResponse);
  }
}

async function runMetrics(
  events: Event[],
  metrics?: Metric[],
): Promise<Record<string, MetricResult>> {
  const results: Record<string, MetricResult> = {};

  if (!metrics || metrics.length === 0) {
    return results;
  }

  for (const metric of metrics) {
    try {
      results[metric.name] = await metric.evaluate(events);
    } catch (error) {
      results[metric.name] = {
        passed: false,
        evidence: [
          `Metric evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  return results;
}

async function createEvalContext(
  evalCase: EvalCase,
  options?: RunEvalOptions,
): Promise<EvalContext> {
  const sessionService = new EvalSessionService();

  const mainSession = await sessionService.createEvalSession(
    'eval',
    evalCase.initialState,
  );

  const userAgentSession = await sessionService.createUserAgentSession(
    'eval-user-agent',
  );

  const bridge = createBridge(evalCase.bridge);

  const runner = new EvalRunner({
    sessionService,
    toolMocks: evalCase.toolMocks,
    middleware: options?.middleware,
  });

  if (evalCase.firstMessage) {
    mainSession.addMessage(evalCase.firstMessage);
  }

  return {
    evalCase,
    runner,
    mainSession,
    userAgentSession,
    bridge,
    sessionService,
    middleware: options?.middleware,
    state: {
      turns: 0,
      startTime: Date.now(),
      tokenUsage: { input: 0, output: 0 },
    },
  };
}

async function runSimulationStep(ctx: EvalContext): Promise<StepResult> {
  const result = await ctx.runner.run(ctx.evalCase.runnable, ctx.mainSession as BaseSession);

  ctx.state.tokenUsage = extractTokenUsage(ctx.mainSession.events);

  if (result.status === 'completed') {
    return { done: true, outcome: 'completed', output: result.output };
  }

  if (result.status === 'error') {
    return { done: true, outcome: 'error', error: result.error };
  }

  const yieldInfo = getYieldInfo(result);
  if (!yieldInfo) {
    return { done: true, outcome: 'completed' };
  }

  await handleYield(
    ctx.mainSession,
    ctx.userAgentSession,
    yieldInfo,
    ctx.evalCase.userAgents,
    ctx.bridge,
    ctx.sessionService,
    ctx.middleware,
  );

  ctx.state.turns++;

  const termCheck = checkTermination(
    ctx.mainSession,
    ctx.state,
    ctx.evalCase.terminateWhen,
  );

  if (termCheck.terminated) {
    return { done: true, outcome: 'terminated', reason: termCheck.reason! };
  }

  return { done: false };
}

async function finalizeEval(
  ctx: EvalContext,
  outcome: StepOutcome,
  options?: {
    terminationReason?: TerminationReason;
    error?: EvalError;
  },
): Promise<EvalResult> {
  const events = [...ctx.mainSession.events];
  const metricResults = await runMetrics(events, ctx.evalCase.metrics);

  let status: EvalStatus;
  if (outcome === 'completed') {
    status = Object.values(metricResults).every((r) => r.passed)
      ? 'passed'
      : 'failed';
  } else {
    status = outcome;
  }

  return {
    name: ctx.evalCase.name,
    status,
    metrics: metricResults,
    events,
    durationMs: Date.now() - ctx.state.startTime,
    turns: ctx.state.turns,
    tokenUsage: ctx.state.tokenUsage,
    ...(options?.terminationReason && {
      terminationReason: options.terminationReason,
    }),
    ...(options?.error && { error: options.error }),
  };
}

export interface RunEvalOptions {
  middleware?: Middleware[];
}

export async function runEval(
  evalCase: EvalCase,
  options?: RunEvalOptions,
): Promise<EvalResult> {
  const ctx = await createEvalContext(evalCase, options);

  try {
    while (true) {
      const step = await runSimulationStep(ctx);

      if (!step.done) {
        continue;
      }

      switch (step.outcome) {
        case 'completed':
          return finalizeEval(ctx, 'completed');

        case 'error':
          return finalizeEval(ctx, 'error', {
            error: { phase: 'system', message: step.error },
          });

        case 'terminated':
          return finalizeEval(ctx, 'terminated', {
            terminationReason: step.reason,
          });
      }
    }
  } catch (error) {
    const phase = error instanceof EvalUserAgentError ? 'userAgent' : 'system';

    return finalizeEval(ctx, 'error', {
      error: {
        phase,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
}

export async function runEvalSuite(
  config: EvalSuiteConfig,
  options?: RunEvalOptions,
): Promise<EvalSuiteResult> {
  const startTime = Date.now();
  const results: EvalResult[] = [];

  const runCase = async (evalCase: EvalCase): Promise<EvalResult> => {
    return runEval(evalCase, options);
  };

  if (config.parallel !== false) {
    const promises = config.cases.map(runCase);

    if (config.stopOnFirstFailure) {
      for (const promise of promises) {
        const result = await promise;
        results.push(result);
        if (result.status === 'failed' || result.status === 'error') {
          break;
        }
      }
    } else {
      const allResults = await Promise.all(promises);
      results.push(...allResults);
    }
  } else {
    for (const evalCase of config.cases) {
      const result = await runCase(evalCase);
      results.push(result);

      if (
        config.stopOnFirstFailure &&
        (result.status === 'failed' || result.status === 'error')
      ) {
        break;
      }
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    errors: results.filter((r) => r.status === 'error').length,
    terminated: results.filter((r) => r.status === 'terminated').length,
  };

  return {
    summary,
    results,
    durationMs: Date.now() - startTime,
  };
}
