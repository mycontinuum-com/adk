import type {
  Runnable,
  Session,
  User,
  YieldContext,
  YieldResponse,
  StateChanges,
} from '../types';
import type { SessionService } from '../types';
import type { Middleware } from '../middleware/types';
import { BaseRunner } from '../core';
import { BaseSession } from '../session';

export interface Bridge {
  formatPrompt?: (
    mainSession: Session,
    ctx: YieldContext,
  ) => string | Promise<string>;

  formatResponse?: (
    output: unknown,
    userAgentSession: Session,
    ctx: YieldContext,
  ) => unknown | Promise<unknown>;
}

export interface AgentUserConfig {
  loop?: Runnable;
  tools?: Record<string, Runnable>;
  bridge?: Bridge;
  session?: Session;
  sessionService?: SessionService;
  middleware?: Middleware[];
}

const STATE_CHANGE_MARKER = Symbol.for('adk.eval.stateChange');

interface StateChangeResult<T = unknown> {
  result: T;
  stateChanges: StateChanges;
}

function isStateChangeResult(value: unknown): value is StateChangeResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    STATE_CHANGE_MARKER in value &&
    (value as Record<symbol, unknown>)[STATE_CHANGE_MARKER] === true
  );
}

function unwrapStateChange(value: unknown): unknown {
  if (isStateChangeResult(value)) {
    return value.result;
  }
  return value;
}

function collectStateChanges(results: unknown[]): StateChanges {
  const changes: StateChanges = {};

  for (const result of results) {
    if (isStateChangeResult(result)) {
      if (result.stateChanges.session) {
        changes.session = {
          ...changes.session,
          ...result.stateChanges.session,
        };
      }
      if (result.stateChanges.user) {
        changes.user = { ...changes.user, ...result.stateChanges.user };
      }
      if (result.stateChanges.patient) {
        changes.patient = {
          ...changes.patient,
          ...result.stateChanges.patient,
        };
      }
      if (result.stateChanges.practice) {
        changes.practice = {
          ...changes.practice,
          ...result.stateChanges.practice,
        };
      }
    }
  }

  return changes;
}

function defaultFormatPrompt(mainSession: Session, ctx: YieldContext): string {
  if (ctx.yieldType === 'loop') {
    return ctx.lastAssistantText ?? '';
  }

  return JSON.stringify({
    toolName: ctx.toolName,
    args: ctx.args,
  });
}

function defaultFormatResponse(
  output: unknown,
  _userAgentSession: Session,
  _ctx: YieldContext,
): unknown {
  return output;
}

export class AgentUserError extends Error {
  constructor(
    public readonly type: 'loop' | 'tool',
    public readonly toolName?: string,
    public readonly args?: unknown,
  ) {
    super(
      type === 'loop'
        ? 'No user agent configured for loop yields'
        : `No user agent configured for tool: ${toolName}`,
    );
    this.name = 'AgentUserError';
  }
}

export function createAgentUser(config: AgentUserConfig): User {
  const formatPrompt = config.bridge?.formatPrompt ?? defaultFormatPrompt;
  const formatResponse = config.bridge?.formatResponse ?? defaultFormatResponse;

  let userAgentSession: BaseSession | null = config.session
    ? (config.session as BaseSession)
    : null;

  const getOrCreateSession = (): BaseSession => {
    if (!userAgentSession) {
      userAgentSession = new BaseSession('agent-user', {
        id: `agent-user-${Date.now()}`,
      });
    }
    return userAgentSession;
  };

  const processCall = async (
    ctx: YieldContext,
    toolName: string,
    args: unknown,
    callId: string,
  ): Promise<unknown> => {
    const userAgent = config.tools?.[toolName];
    if (!userAgent) {
      throw new AgentUserError('tool', toolName, args);
    }

    const session = getOrCreateSession();
    const prompt = await formatPrompt(ctx.session, { ...ctx, toolName, args });

    session.addMessage(prompt);

    const runner = new BaseRunner({
      sessionService: config.sessionService,
      middleware: config.middleware,
    });

    const result = await runner.run(userAgent, session);
    const output = result.status === 'completed' ? result.output : undefined;

    const formattedResponse = await formatResponse(output, session, ctx);
    return unwrapStateChange(formattedResponse);
  };

  return {
    name: 'AgentUser',

    async onYield(ctx: YieldContext): Promise<YieldResponse> {
      if (ctx.yieldType === 'loop') {
        const userAgent = config.loop;
        if (!userAgent) {
          throw new AgentUserError('loop');
        }

        const session = getOrCreateSession();
        const prompt = await formatPrompt(ctx.session, ctx);

        session.addMessage(prompt);

        const runner = new BaseRunner({
          sessionService: config.sessionService,
          middleware: config.middleware,
        });

        const result = await runner.run(userAgent, session);
        const output =
          result.status === 'completed' ? result.output : undefined;

        const toolResultEvents = session.events.filter(
          (e) => e.type === 'tool_result',
        );
        const results = toolResultEvents.map(
          (e) => (e as { result?: unknown }).result,
        );
        const stateChanges = collectStateChanges(results);

        const formattedResponse = await formatResponse(output, session, ctx);
        const text = String(unwrapStateChange(formattedResponse) ?? '');

        return {
          type: 'message',
          text,
          stateChanges:
            Object.keys(stateChanges).length > 0 ? stateChanges : undefined,
        };
      }

      if (ctx.pendingCalls.length === 1) {
        const call = ctx.pendingCalls[0]!;
        const input = await processCall(ctx, call.name, call.args, call.callId);

        const session = getOrCreateSession();
        const toolResultEvents = session.events.filter(
          (e) => e.type === 'tool_result',
        );
        const results = toolResultEvents.map(
          (e) => (e as { result?: unknown }).result,
        );
        const stateChanges = collectStateChanges(results);

        return {
          type: 'tool_input',
          input,
          stateChanges:
            Object.keys(stateChanges).length > 0 ? stateChanges : undefined,
        };
      }

      const inputs = new Map<string, unknown>();
      const responses = await Promise.all(
        ctx.pendingCalls.map((call) =>
          processCall(ctx, call.name, call.args, call.callId).then((input) => ({
            callId: call.callId,
            input,
          })),
        ),
      );

      for (const { callId, input } of responses) {
        inputs.set(callId, input);
      }

      const session = getOrCreateSession();
      const toolResultEvents = session.events.filter(
        (e) => e.type === 'tool_result',
      );
      const results = toolResultEvents.map(
        (e) => (e as { result?: unknown }).result,
      );
      const stateChanges = collectStateChanges(results);

      return {
        type: 'tool_inputs',
        inputs,
        stateChanges:
          Object.keys(stateChanges).length > 0 ? stateChanges : undefined,
      };
    },
  };
}
