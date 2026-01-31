import type { Runnable } from './runnables';
import type { Correction } from '../parser';

export type EventType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'assistant_delta'
  | 'thought'
  | 'thought_delta'
  | 'tool_call'
  | 'tool_yield'
  | 'tool_input'
  | 'tool_result'
  | 'state_change'
  | 'invocation_start'
  | 'invocation_end'
  | 'invocation_yield'
  | 'invocation_resume'
  | 'model_start'
  | 'model_end';

export type InvocationEndReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'transferred'
  | 'max_steps';

export type InvocationOutcome = InvocationEndReason | 'yielded';

export type StateScope = 'session' | 'user' | 'patient' | 'practice' | 'temp';

export interface ProviderContext {
  provider: string;
  data: unknown;
}

export interface EventBase {
  id: string;
  type: EventType;
  createdAt: number;
  invocationId: string;
  agentName: string;
  providerContext?: ProviderContext;
}

interface TextEvent<T extends EventType> extends EventBase {
  type: T;
  text: string;
}

export interface PartialOutputState {
  value: unknown;
  complete: boolean;
  corrections: Correction[];
}

export interface ParsedOutput {
  value: unknown;
  corrections: Correction[];
  totalScore: number;
}

export type SystemEvent = TextEvent<'system'>;
export type UserEvent = Omit<
  TextEvent<'user'>,
  'invocationId' | 'agentName'
> & {
  invocationId?: string;
  agentName?: string;
};
export type AssistantEvent = TextEvent<'assistant'> & {
  output?: ParsedOutput;
};
export type ThoughtEvent = TextEvent<'thought'>;

export interface ToolCallEvent extends EventBase {
  type: 'tool_call';
  callId: string;
  name: string;
  args: Record<string, unknown>;
  yields?: boolean;
}

export interface ToolYieldEvent extends EventBase {
  type: 'tool_yield';
  callId: string;
  name: string;
  preparedArgs: unknown;
}

export interface ToolInputEvent extends Omit<
  EventBase,
  'invocationId' | 'agentName'
> {
  type: 'tool_input';
  callId: string;
  name: string;
  input: unknown;
  invocationId?: string;
  agentName?: string;
}

export type ToolResultEventBase = Pick<
  ToolResultEvent,
  | 'id'
  | 'type'
  | 'createdAt'
  | 'callId'
  | 'name'
  | 'providerContext'
  | 'invocationId'
  | 'agentName'
>;

export interface ToolResultEvent extends EventBase {
  type: 'tool_result';
  callId: string;
  name: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
  retryCount?: number;
  timedOut?: boolean;
}

export type StateChangeSource = 'observation' | 'mutation';

export type StateChangeEvent = Omit<EventBase, 'invocationId' | 'agentName'> & {
  type: 'state_change';
  scope: StateScope;
  source: StateChangeSource;
  invocationId?: string;
  agentName?: string;
  changes: Array<{
    key: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
};

export type InvocationKind =
  | 'agent'
  | 'step'
  | 'sequence'
  | 'parallel'
  | 'loop';

interface InvocationEventFields {
  agentName: string;
  parentInvocationId?: string;
}

export type HandoffOrigin =
  | { type: 'call'; invocationId: string; callId?: string }
  | { type: 'spawn'; invocationId: string; callId?: string }
  | { type: 'dispatch'; invocationId: string; callId?: string }
  | { type: 'transfer'; invocationId: string; agentName?: string };

export interface InvocationStartEvent extends EventBase, InvocationEventFields {
  type: 'invocation_start';
  invocationId: string;
  kind: InvocationKind;
  handoffOrigin?: HandoffOrigin;
  fingerprint?: string;
  version?: string;
}

export interface HandoffTarget {
  invocationId: string;
  agentName: string;
}

export interface InvocationEndEvent extends EventBase, InvocationEventFields {
  type: 'invocation_end';
  invocationId: string;
  kind?: InvocationKind;
  reason: InvocationEndReason;
  iterations?: number;
  error?: string;
  handoffTarget?: HandoffTarget;
}

export interface InvocationYieldEvent extends EventBase, InvocationEventFields {
  type: 'invocation_yield';
  invocationId: string;
  pendingCallIds: string[];
  yieldIndex: number;
  awaitingInput?: boolean;
}

export interface InvocationResumeEvent
  extends EventBase, InvocationEventFields {
  type: 'invocation_resume';
  invocationId: string;
  yieldIndex: number;
}

export interface ContextMessageSummary {
  role:
    | 'system'
    | 'user'
    | 'assistant'
    | 'tool_call'
    | 'tool_result'
    | 'thought';
  content: string;
}

export interface ContextToolSummary {
  name: string;
  description: string;
}

export interface ModelStartEvent extends EventBase {
  type: 'model_start';
  stepIndex: number;
  messages: ContextMessageSummary[];
  tools: ContextToolSummary[];
  outputSchema?: string;
  serializedSchema?: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  outputTokens: number;
}

export interface ModelEndEvent extends EventBase {
  type: 'model_end';
  stepIndex: number;
  durationMs: number;
  usage?: ModelUsage;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  error?: string;
  modelName?: string;
}

export type Event =
  | SystemEvent
  | UserEvent
  | AssistantEvent
  | ThoughtEvent
  | ToolCallEvent
  | ToolYieldEvent
  | ToolInputEvent
  | ToolResultEvent
  | StateChangeEvent
  | InvocationStartEvent
  | InvocationEndEvent
  | InvocationYieldEvent
  | InvocationResumeEvent
  | ModelStartEvent
  | ModelEndEvent;

interface DeltaEvent<
  T extends 'thought_delta' | 'assistant_delta',
> extends EventBase {
  type: T;
  delta: string;
  text: string;
}

export type ThoughtDeltaEvent = DeltaEvent<'thought_delta'>;
export type AssistantDeltaEvent = DeltaEvent<'assistant_delta'> & {
  partial?: PartialOutputState;
};

export type StreamEvent =
  | SystemEvent
  | UserEvent
  | ThoughtEvent
  | ThoughtDeltaEvent
  | AssistantEvent
  | AssistantDeltaEvent
  | ToolCallEvent
  | ToolYieldEvent
  | ToolInputEvent
  | ToolResultEvent
  | StateChangeEvent
  | InvocationStartEvent
  | InvocationEndEvent
  | InvocationYieldEvent
  | InvocationResumeEvent
  | ModelStartEvent
  | ModelEndEvent;

export interface ErrorContext {
  invocationId: string;
  agent: Runnable;
  phase: 'model' | 'tool' | 'callback' | 'render';
  attempt: number;
  error: Error;
  toolName?: string;
  callId?: string;
  invocationStack?: string[];
  timestamp: number;
}
