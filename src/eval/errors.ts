export class EvalToolError extends Error {
  readonly toolName: string;
  readonly args: unknown;

  constructor(toolName: string, args: unknown) {
    const message = `Tool '${toolName}' was called during eval but no mock was provided.

Add a mock:
  toolMocks: {
    ${toolName}: { execute: (args) => ({ /* mock result */ }) }
  }

Or if this tool has no side effects, provide the actual tool:
  import { ${toolName} } from './tools';
  toolMocks: { ${toolName} }

Tool was called with args:
  ${JSON.stringify(args, null, 2)}`;

    super(message);
    this.name = 'EvalToolError';
    this.toolName = toolName;
    this.args = args;
  }
}

export class EvalUserAgentError extends Error {
  readonly toolName?: string;
  readonly yieldType: 'loop' | 'tool';
  readonly args?: unknown;

  constructor(yieldType: 'loop' | 'tool', toolName?: string, args?: unknown) {
    let message: string;

    if (yieldType === 'tool' && toolName) {
      message = `Tool '${toolName}' yielded but no user agent was provided.

Add a tool yield agent:
  userAgents: {
    tools: {
      ${toolName}: agent({ ... })
    }
  }

Yield occurred with args:
  ${JSON.stringify(args, null, 2)}`;
    } else {
      message = `Loop yielded but no loop user agent was provided.

Add a loop user agent:
  userAgents: {
    loop: agent({ ... })
  }`;
    }

    super(message);
    this.name = 'EvalUserAgentError';
    this.yieldType = yieldType;
    this.toolName = toolName;
    this.args = args;
  }
}

export class EvalTerminatedError extends Error {
  readonly reason: 'maxTurns' | 'maxDuration' | 'stateMatches';

  constructor(reason: 'maxTurns' | 'maxDuration' | 'stateMatches') {
    const messages: Record<typeof reason, string> = {
      maxTurns: 'Evaluation terminated: maximum turns reached',
      maxDuration: 'Evaluation terminated: maximum duration exceeded',
      stateMatches: 'Evaluation terminated: state condition matched',
    };

    super(messages[reason]);
    this.name = 'EvalTerminatedError';
    this.reason = reason;
  }
}
