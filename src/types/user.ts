import type { Session, ToolCallEvent, StateScope } from './index';

export interface StateChanges {
  session?: Record<string, unknown>;
  user?: Record<string, unknown>;
  patient?: Record<string, unknown>;
  practice?: Record<string, unknown>;
}

export interface YieldContext {
  session: Session;
  invocationId: string;
  agentName: string;
  yieldType: 'tool' | 'loop';

  toolName?: string;
  callId?: string;
  args?: unknown;

  pendingCalls: ToolCallEvent[];

  lastAssistantText?: string;
  iteration?: number;
}

export type YieldResponse =
  | { type: 'tool_input'; input: unknown; stateChanges?: StateChanges }
  | {
      type: 'tool_inputs';
      inputs: Map<string, unknown>;
      stateChanges?: StateChanges;
    }
  | { type: 'message'; text: string; stateChanges?: StateChanges };

export interface User {
  name: string;
  onYield(ctx: YieldContext): Promise<YieldResponse>;
}

export interface CallContext {
  callIndex: number;
  callId: string;
  invocationId: string;
}

export type ToolHandler =
  | unknown[]
  | ((args: unknown, ctx: CallContext) => unknown | Promise<unknown>);

export interface ScriptedUserConfig {
  tools?: Record<string, ToolHandler>;
  messages?: string[] | ((text: string) => string);
}

export interface HumanUserOptions {
  formatPrompt?: (ctx: YieldContext) => string;
  parseInput?: (input: string, ctx: YieldContext) => unknown;
}
