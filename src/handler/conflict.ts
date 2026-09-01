import type { Session } from '../types'
import type { CommitStatus } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { SessionService } from '../types/session'
import type { HandlerInput, HandlerConfig } from './types'

import { BaseSession, seedState } from '../session'
import { applySchemaDefaults } from '../types/schema'

type ResolvedConfig<S extends StateSchema> = HandlerConfig<S> & { sessionService: SessionService }

export async function resolveSession<S extends StateSchema>(
  config: ResolvedConfig<S>,
  sessionId: string,
): Promise<Session<S>> {
  const existing = await config.sessionService.getSession(config.appName, sessionId)
  if (existing) return existing as Session<S>
  return new BaseSession(config.appName, { id: sessionId }) as Session<S>
}

export function applyInput(session: Session, input: HandlerInput, schema?: StateSchema): void {
  if (input.input.state) {
    session.state.update(applySchemaDefaults(input.input.state, schema?.session))
  }
  if (input.input.initialState) {
    seedState(session as BaseSession, input.input.initialState, schema)
  }
  if (input.input.tools) {
    for (const ti of input.input.tools) {
      session.input.tool({ callId: ti.callId, input: ti.input })
    }
    return
  }
  if (input.input.message) {
    session.input.message(input.input.message)
  }
}

export async function resolveConflict<S extends StateSchema>(
  config: ResolvedConfig<S>,
  session: Session,
  eventCountBeforeInput: number,
): Promise<CommitStatus> {
  const latest = await config.sessionService.getSession(config.appName, session.id)
  const inputTs = findLastUserTimestamp(session, eventCountBeforeInput)
  if (inputTs != null && latest?.events.some((e) => e.type === 'user' && e.createdAt > inputTs)) {
    return 'skipped'
  }
  const merged = await config.sessionService.mergeSession(session, latest ?? undefined)
  if (!merged.ok) {
    console.warn('session.merge.orphaned', {
      sessionId: session.id,
      currentVersion: merged.currentVersion,
    })
    return 'orphaned'
  }
  return 'merged'
}

function findLastUserTimestamp(session: Session, fromIndex: number): number | undefined {
  for (let i = session.events.length - 1; i >= fromIndex; i--) {
    const e = session.events[i]
    if (e.type === 'user') return e.createdAt
  }
  return undefined
}
