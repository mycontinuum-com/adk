import type {
  User,
  YieldContext,
  YieldResponse,
  CallContext,
  ScriptedUserConfig,
  ToolHandler,
} from '../types';

class ScriptedUserExhaustedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly callIndex: number,
  ) {
    super(
      `ScriptedUser: No more responses for tool '${toolName}' (call index: ${callIndex})`,
    );
    this.name = 'ScriptedUserExhaustedError';
  }
}

class ScriptedUserNoHandlerError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly yieldType: 'tool' | 'loop',
  ) {
    super(
      yieldType === 'tool'
        ? `ScriptedUser: No handler for tool '${toolName}'`
        : `ScriptedUser: No handler for loop yield (expected 'messages' config)`,
    );
    this.name = 'ScriptedUserNoHandlerError';
  }
}

export function createScriptedUser(config: ScriptedUserConfig): User {
  const callCounts = new Map<string, number>();
  let messageIndex = 0;

  const getToolResponse = async (
    toolName: string,
    args: unknown,
    callId: string,
    invocationId: string,
  ): Promise<unknown> => {
    const handler = config.tools?.[toolName];
    if (!handler) {
      throw new ScriptedUserNoHandlerError(toolName, 'tool');
    }

    const callIndex = callCounts.get(toolName) ?? 0;
    callCounts.set(toolName, callIndex + 1);

    const ctx: CallContext = {
      callIndex,
      callId,
      invocationId,
    };

    if (Array.isArray(handler)) {
      if (callIndex >= handler.length) {
        throw new ScriptedUserExhaustedError(toolName, callIndex);
      }
      return handler[callIndex];
    }

    return handler(args, ctx);
  };

  const getMessageResponse = (lastText?: string): string => {
    if (!config.messages) {
      throw new ScriptedUserNoHandlerError('', 'loop');
    }

    if (typeof config.messages === 'function') {
      return config.messages(lastText ?? '');
    }

    if (messageIndex >= config.messages.length) {
      throw new Error(
        `ScriptedUser: No more messages (index: ${messageIndex})`,
      );
    }

    return config.messages[messageIndex++];
  };

  return {
    name: 'ScriptedUser',

    async onYield(ctx: YieldContext): Promise<YieldResponse> {
      if (ctx.yieldType === 'loop') {
        return {
          type: 'message',
          text: getMessageResponse(ctx.lastAssistantText),
        };
      }

      if (ctx.pendingCalls.length === 1) {
        const call = ctx.pendingCalls[0]!;
        const input = await getToolResponse(
          call.name,
          call.args,
          call.callId,
          ctx.invocationId,
        );
        return { type: 'tool_input', input };
      }

      const inputs = new Map<string, unknown>();
      for (const call of ctx.pendingCalls) {
        const input = await getToolResponse(
          call.name,
          call.args,
          call.callId,
          ctx.invocationId,
        );
        inputs.set(call.callId, input);
      }
      return { type: 'tool_inputs', inputs };
    },
  };
}

export { ScriptedUserExhaustedError, ScriptedUserNoHandlerError };
