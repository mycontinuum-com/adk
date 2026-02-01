import type {
  ContextRenderer,
  SystemEvent,
  Session,
  Event,
  UserEvent,
} from '../types';
import type { StateSchema, StateValues } from '../types/schema';
import { createEventId, type BaseSession } from '../session';
import { computeAllStatesAtEvent } from '../session/snapshot';
import { renderSchema } from './renderSchema';

export interface MessagePromptContext<T extends StateSchema> {
  state: StateValues<T>;
  outputSchema?: string;
}

export interface EnrichmentPromptContext<T extends StateSchema> {
  state: Partial<StateValues<T>>;
  outputSchema?: string;
  message: string;
}

function buildStateValues<T extends StateSchema>(
  session: Session,
  invocationId: string,
): StateValues<T> {
  const bound = (session as BaseSession).boundState(invocationId);
  const sessionState = bound.session.toObject();
  const userState = bound.user.toObject();
  const patientState = bound.patient.toObject();
  const practiceState = bound.practice.toObject();
  const tempState = bound.temp.toObject();

  return {
    ...sessionState,
    session: sessionState,
    user: userState,
    patient: patientState,
    practice: practiceState,
    temp: tempState,
  } as StateValues<T>;
}

declare const promptBrand: unique symbol;

export interface MessagePrompt<T extends StateSchema> {
  readonly [promptBrand]: T;
  readonly render: ((ctx: MessagePromptContext<T>) => string) | string;
}

export interface EnrichmentPrompt<T extends StateSchema> {
  readonly [promptBrand]: T;
  readonly render: (ctx: EnrichmentPromptContext<T>) => string;
}

export type Prompt<T extends StateSchema> =
  | MessagePrompt<T>
  | EnrichmentPrompt<T>;

export function message<T extends StateSchema>(
  _schema: T,
  render: ((ctx: MessagePromptContext<T>) => string) | string,
): MessagePrompt<T> {
  return { render } as MessagePrompt<T>;
}

export function enrichment<T extends StateSchema>(
  _schema: T,
  render: (ctx: EnrichmentPromptContext<T>) => string,
): EnrichmentPrompt<T> {
  return { render } as EnrichmentPrompt<T>;
}

export function injectSystemMessage(text: string): ContextRenderer;
export function injectSystemMessage<T extends StateSchema>(
  prompt: MessagePrompt<T>,
): ContextRenderer;
export function injectSystemMessage<T extends StateSchema>(
  input: string | MessagePrompt<T>,
): ContextRenderer {
  if (typeof input === 'string') {
    return (renderCtx) => {
      const systemEvent: SystemEvent = {
        id: createEventId(),
        type: 'system',
        createdAt: Date.now(),
        invocationId: renderCtx.invocationId,
        agentName: renderCtx.agentName,
        text: input,
      };

      return {
        ...renderCtx,
        events: [...renderCtx.events, systemEvent],
      };
    };
  }

  const prompt = input;
  if (typeof prompt.render === 'string') {
    const text = prompt.render;
    return (renderCtx) => {
      const systemEvent: SystemEvent = {
        id: createEventId(),
        type: 'system',
        createdAt: Date.now(),
        invocationId: renderCtx.invocationId,
        agentName: renderCtx.agentName,
        text,
      };

      return {
        ...renderCtx,
        events: [...renderCtx.events, systemEvent],
      };
    };
  }

  const renderFn = prompt.render;
  return (renderCtx) => {
    const state = buildStateValues<T>(
      renderCtx.session,
      renderCtx.invocationId,
    );
    const outputSchema = renderCtx.outputSchema
      ? renderSchema(renderCtx.outputSchema)
      : undefined;
    const ctx: MessagePromptContext<T> = { state, outputSchema };
    const text = renderFn(ctx);

    const systemEvent: SystemEvent = {
      id: createEventId(),
      type: 'system',
      createdAt: Date.now(),
      invocationId: renderCtx.invocationId,
      agentName: renderCtx.agentName,
      text,
    };

    return {
      ...renderCtx,
      events: [...renderCtx.events, systemEvent],
    };
  };
}

export function injectUserMessage<T extends StateSchema>(
  prompt: MessagePrompt<T>,
): ContextRenderer {
  if (typeof prompt.render === 'string') {
    const text = prompt.render;
    return (renderCtx) => {
      const userEvent: UserEvent = {
        id: createEventId(),
        type: 'user',
        createdAt: Date.now(),
        text,
      };

      return {
        ...renderCtx,
        events: [...renderCtx.events, userEvent],
      };
    };
  }

  const renderFn = prompt.render;
  return (renderCtx) => {
    const state = buildStateValues<T>(
      renderCtx.session,
      renderCtx.invocationId,
    );
    const outputSchema = renderCtx.outputSchema
      ? renderSchema(renderCtx.outputSchema)
      : undefined;
    const ctx: MessagePromptContext<T> = { state, outputSchema };
    const text = renderFn(ctx);

    const userEvent: UserEvent = {
      id: createEventId(),
      type: 'user',
      createdAt: Date.now(),
      text,
    };

    return {
      ...renderCtx,
      events: [...renderCtx.events, userEvent],
    };
  };
}

export interface WrapUserMessagesOptions {
  targetAgent?: string | null;
}

export function wrapUserMessages(
  transform: (message: string) => string,
  options?: WrapUserMessagesOptions,
): ContextRenderer {
  return (renderCtx) => {
    const result: Event[] = [];
    let currentAgentName: string | undefined;

    for (const event of renderCtx.events) {
      if (event.type === 'invocation_start') {
        currentAgentName = event.agentName;
      } else if (event.type === 'invocation_end') {
        currentAgentName = undefined;
      }

      if (event.type !== 'user') {
        result.push(event);
        continue;
      }

      let shouldWrap = true;
      if (options?.targetAgent === null) {
        shouldWrap = currentAgentName === undefined;
      } else if (options?.targetAgent !== undefined) {
        shouldWrap = currentAgentName === options.targetAgent;
      }
      if (!shouldWrap) {
        result.push(event);
        continue;
      }

      const userEvent = event as UserEvent;
      result.push({ ...userEvent, text: transform(userEvent.text) });
    }

    return { ...renderCtx, events: result };
  };
}

export type EnrichStateAt = 'message' | 'invocation' | 'current';

export interface EnrichUserMessagesOptions {
  targetAgent?: string | null;
  at?: EnrichStateAt;
}

function findInvocationStartIndex(
  events: readonly Event[],
  invocationId: string | undefined,
): number {
  if (!invocationId) return 0;
  const idx = events.findIndex(
    (e) => e.type === 'invocation_start' && e.invocationId === invocationId,
  );
  return idx >= 0 ? idx : 0;
}

export function enrichUserMessages<T extends StateSchema>(
  prompt: EnrichmentPrompt<T>,
  options?: EnrichUserMessagesOptions,
): ContextRenderer {
  const stateAt = options?.at ?? 'message';

  return (renderCtx) => {
    const sessionEvents = renderCtx.session.events;
    const result: Event[] = [];

    let currentAgentName: string | undefined;

    const currentStateValues =
      stateAt === 'current'
        ? buildStateValues<T>(renderCtx.session, renderCtx.invocationId)
        : null;

    for (const event of renderCtx.events) {
      if (event.type === 'invocation_start') {
        currentAgentName = event.agentName;
      } else if (event.type === 'invocation_end') {
        currentAgentName = undefined;
      }

      if (event.type !== 'user') {
        result.push(event);
        continue;
      }

      const shouldEnrich =
        options?.targetAgent === undefined
          ? true
          : options.targetAgent === null
            ? currentAgentName === undefined
            : currentAgentName === options.targetAgent;
      if (!shouldEnrich) {
        result.push(event);
        continue;
      }

      let stateValues: Partial<StateValues<T>>;
      if (currentStateValues) {
        stateValues = currentStateValues;
      } else {
        let stateIndex: number;
        if (stateAt === 'invocation') {
          const userEvent = event as UserEvent;
          stateIndex = findInvocationStartIndex(
            sessionEvents,
            userEvent.invocationId,
          );
        } else {
          const eventIndex = sessionEvents.findIndex((e) => e.id === event.id);
          stateIndex = eventIndex > 0 ? eventIndex - 1 : 0;
        }

        stateValues = {};
        if (sessionEvents.length > 0) {
          const states = computeAllStatesAtEvent(sessionEvents, stateIndex);
          stateValues = {
            ...states.session,
            session: states.session,
            user: states.user,
            patient: states.patient,
            practice: states.practice,
          } as Partial<StateValues<T>>;
        }
      }

      const userEvent = event as UserEvent;
      const outputSchema = renderCtx.outputSchema
        ? renderSchema(renderCtx.outputSchema)
        : undefined;
      const ctx: EnrichmentPromptContext<T> = {
        state: stateValues,
        outputSchema,
        message: userEvent.text,
      };
      const enrichedMessage = prompt.render(ctx);

      result.push({ ...userEvent, text: enrichedMessage });
    }

    return { ...renderCtx, events: result };
  };
}
