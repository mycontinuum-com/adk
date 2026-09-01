import type { SyncContextRenderer, SystemEvent, Session, Event, UserEvent } from '../types'
import type { StateSchema, StateValues } from '../types/schema'

import { createEventId } from '../session'
import { computeAllStatesAtEvent } from '../session/snapshot'
import { renderSchema } from './renderSchema'

export interface MessagePromptContext<T extends StateSchema> {
  state: StateValues<T>
  outputSchema?: string
}

export interface EnrichmentPromptContext<T extends StateSchema> {
  state: Partial<StateValues<T>>
  outputSchema?: string
  message: string
}

function extractScopeData(scope: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const key of Object.keys(scope)) {
    data[key] = scope[key]
  }
  return data
}

function buildStateValues<T extends StateSchema>(
  session: Session,
  invocationId: string,
): StateValues<T> {
  const bound = session.boundState(invocationId)
  const sessionState = extractScopeData(bound)

  return {
    ...sessionState,
    session: sessionState,
    user: extractScopeData(bound.user),
    patient: extractScopeData(bound.patient),
    practice: extractScopeData(bound.practice),
    org: extractScopeData(bound.org),
    team: extractScopeData(bound.team),
    temp: extractScopeData(bound.temp),
  } as StateValues<T>
}

declare const promptBrand: unique symbol

export interface MessagePrompt<T extends StateSchema> {
  readonly [promptBrand]: T
  readonly render: ((ctx: MessagePromptContext<T>) => string) | string
}

export interface EnrichmentPrompt<T extends StateSchema> {
  readonly [promptBrand]: T
  readonly render: (ctx: EnrichmentPromptContext<T>) => string
}

export type Prompt<T extends StateSchema> = MessagePrompt<T> | EnrichmentPrompt<T>

export function message<T extends StateSchema>(
  _schema: T,
  render: ((ctx: MessagePromptContext<T>) => string) | string,
): MessagePrompt<T> {
  return { render } as MessagePrompt<T>
}

export function enrichment<T extends StateSchema>(
  _schema: T,
  render: (ctx: EnrichmentPromptContext<T>) => string,
): EnrichmentPrompt<T> {
  return { render } as EnrichmentPrompt<T>
}

export function injectSystemMessage<S extends StateSchema = StateSchema>(
  text: string,
): SyncContextRenderer<S>
export function injectSystemMessage<S extends StateSchema>(
  prompt: MessagePrompt<S>,
): SyncContextRenderer<S>
export function injectSystemMessage<S extends StateSchema>(
  input: string | MessagePrompt<S>,
): SyncContextRenderer<S> {
  if (typeof input === 'string') {
    return (renderCtx) => {
      const systemEvent: SystemEvent = {
        id: createEventId(),
        type: 'system',
        createdAt: Date.now(),
        invocationId: renderCtx.invocationId,
        agentName: renderCtx.agentName,
        text: input,
      }

      return {
        ...renderCtx,
        events: [...renderCtx.events, systemEvent],
      }
    }
  }

  const prompt = input
  if (typeof prompt.render === 'string') {
    const text = prompt.render
    return (renderCtx) => {
      const systemEvent: SystemEvent = {
        id: createEventId(),
        type: 'system',
        createdAt: Date.now(),
        invocationId: renderCtx.invocationId,
        agentName: renderCtx.agentName,
        text,
      }

      return {
        ...renderCtx,
        events: [...renderCtx.events, systemEvent],
      }
    }
  }

  const renderFn = prompt.render
  return (renderCtx) => {
    const state = buildStateValues<S>(renderCtx.session, renderCtx.invocationId)
    const outputSchema = renderCtx.outputSchema ? renderSchema(renderCtx.outputSchema) : undefined
    const ctx: MessagePromptContext<S> = { state, outputSchema }
    const text = renderFn(ctx)

    const systemEvent: SystemEvent = {
      id: createEventId(),
      type: 'system',
      createdAt: Date.now(),
      invocationId: renderCtx.invocationId,
      agentName: renderCtx.agentName,
      text,
    }

    return {
      ...renderCtx,
      events: [...renderCtx.events, systemEvent],
    }
  }
}

export function injectUserMessage<S extends StateSchema = StateSchema>(
  prompt: MessagePrompt<S>,
): SyncContextRenderer<S> {
  if (typeof prompt.render === 'string') {
    const text = prompt.render
    return (renderCtx) => {
      const userEvent: UserEvent = {
        id: createEventId(),
        type: 'user',
        createdAt: Date.now(),
        text,
      }

      return {
        ...renderCtx,
        events: [...renderCtx.events, userEvent],
      }
    }
  }

  const renderFn = prompt.render
  return (renderCtx) => {
    const state = buildStateValues<S>(renderCtx.session, renderCtx.invocationId)
    const outputSchema = renderCtx.outputSchema ? renderSchema(renderCtx.outputSchema) : undefined
    const ctx: MessagePromptContext<S> = { state, outputSchema }
    const text = renderFn(ctx)

    const userEvent: UserEvent = {
      id: createEventId(),
      type: 'user',
      createdAt: Date.now(),
      text,
    }

    return {
      ...renderCtx,
      events: [...renderCtx.events, userEvent],
    }
  }
}

export type TransformStateAt = 'message' | 'invocation' | 'current'

export interface TransformUserMessagesOptions {
  targetAgent?: string | null
  at?: TransformStateAt
}

function findInvocationStartIndex(
  events: readonly Event[],
  invocationId: string | undefined,
): number {
  if (!invocationId) return 0
  const idx = events.findIndex(
    (e) => e.type === 'invocation_start' && e.invocationId === invocationId,
  )
  return idx >= 0 ? idx : 0
}

function isEnrichmentPrompt<T extends StateSchema>(
  input: ((message: string) => string) | EnrichmentPrompt<T>,
): input is EnrichmentPrompt<T> {
  return typeof input === 'object' && 'render' in input
}

export function transformUserMessages<T extends StateSchema = StateSchema>(
  transform: ((message: string) => string) | EnrichmentPrompt<T>,
  options?: TransformUserMessagesOptions,
): SyncContextRenderer<T> {
  const stateAt = options?.at ?? 'message'
  const useEnrichment = isEnrichmentPrompt(transform)

  return (renderCtx) => {
    const sessionEvents = renderCtx.session.events
    const result: Event[] = []
    let currentAgentName: string | undefined

    const currentStateValues =
      useEnrichment && stateAt === 'current'
        ? buildStateValues<T>(renderCtx.session, renderCtx.invocationId)
        : null

    for (const event of renderCtx.events) {
      if (event.type === 'invocation_start') {
        currentAgentName = event.agentName
      } else if (event.type === 'invocation_end') {
        currentAgentName = undefined
      }

      if (event.type !== 'user') {
        result.push(event)
        continue
      }

      const shouldTransform =
        options?.targetAgent === undefined
          ? true
          : options.targetAgent === null
            ? currentAgentName === undefined
            : currentAgentName === options.targetAgent
      if (!shouldTransform) {
        result.push(event)
        continue
      }

      const messageText = event.text

      if (!useEnrichment) {
        result.push({ ...event, text: transform(messageText) })
        continue
      }

      let stateValues: Partial<StateValues<T>>
      if (currentStateValues) {
        stateValues = currentStateValues
      } else {
        let stateIndex: number
        if (stateAt === 'invocation') {
          stateIndex = findInvocationStartIndex(sessionEvents, event.invocationId)
        } else {
          const eventIndex = sessionEvents.findIndex((e) => e.id === event.id)
          stateIndex = eventIndex > 0 ? eventIndex - 1 : 0
        }

        stateValues = {}
        if (sessionEvents.length > 0) {
          const states = computeAllStatesAtEvent(sessionEvents, stateIndex)
          stateValues = {
            ...states.session,
            session: states.session,
            ...states.scopedStates,
          } as Partial<StateValues<T>>
        }
      }

      const outputSchema = renderCtx.outputSchema ? renderSchema(renderCtx.outputSchema) : undefined
      const ctx: EnrichmentPromptContext<T> = {
        state: stateValues,
        outputSchema,
        message: messageText,
      }
      const transformedMessage = transform.render(ctx)

      result.push({ ...event, text: transformedMessage })
    }

    return { ...renderCtx, events: result }
  }
}
