import { z } from 'zod'

import type { OutputConfig, OutputMode } from './runnables'

export type StateSchema = {
  session?: Record<string, z.ZodType>
  user?: Record<string, z.ZodType>
  patient?: Record<string, z.ZodType>
  practice?: Record<string, z.ZodType>
  org?: Record<string, z.ZodType>
  team?: Record<string, z.ZodType>
  temp?: Record<string, z.ZodType>
}

/**
 * Runtime-only marker for APIs that accept a runnable or hook with an arbitrary state schema. Keep
 * concrete state schemas generic at application boundaries; use this only where the runner
 * deliberately erases that schema after construction.
 */
export type ErasedStateSchema = z.infer<z.ZodAny>

export type InferScope<T> = [T] extends [Record<string, z.ZodType>]
  ? { [K in keyof T]: z.infer<T[K]> }
  : Record<string, unknown>

type InferScopeStrict<T> =
  T extends Record<string, z.ZodType> ? { [K in keyof T]: z.infer<T[K]> } : Record<string, never>

export type InferStateSchema<T extends StateSchema> = {
  session: InferScopeStrict<T['session']>
  user: InferScopeStrict<T['user']>
  patient: InferScopeStrict<T['patient']>
  practice: InferScopeStrict<T['practice']>
  org: InferScopeStrict<T['org']>
  team: InferScopeStrict<T['team']>
  temp: InferScopeStrict<T['temp']>
}

type ScopeValues<T> = T extends Record<string, z.ZodType> ? { [K in keyof T]: z.infer<T[K]> } : {}

export type StateValues<T extends StateSchema> = ScopeValues<T['session']> & {
  session: ScopeValues<T['session']>
  user: ScopeValues<T['user']>
  patient: ScopeValues<T['patient']>
  practice: ScopeValues<T['practice']>
  org: ScopeValues<T['org']>
  team: ScopeValues<T['team']>
  temp: ScopeValues<T['temp']>
}

export type ScopeState<T extends Record<string, z.ZodType> | undefined> = {
  [K in keyof InferScope<T>]: InferScope<T>[K]
} & {
  update(
    changes: Partial<{
      [K in keyof InferScope<T>]: InferScope<T>[K] | undefined
    }>,
  ): void
}

type SharedScopeKey = 'user' | 'patient' | 'practice' | 'org' | 'team'

type SharedScopeProperties<S extends StateSchema> = {
  readonly [K in Extract<keyof S, SharedScopeKey>]: ScopeState<
    S[K] & (Record<string, z.ZodType> | undefined)
  >
}

export type TypedState<S extends StateSchema = StateSchema> = ScopeState<S['session']> & {
  readonly temp: ScopeState<S['temp']>
} & SharedScopeProperties<S>

type SessionSchema<T extends StateSchema> = NonNullable<T['session']>
type SessionValue<T extends StateSchema, K extends keyof SessionSchema<T>> =
  SessionSchema<T>[K] extends z.ZodType<infer U> ? U : never

export function applySchemaDefaults(
  state: Record<string, unknown>,
  scopeSchema?: Record<string, z.ZodType>,
): Record<string, unknown> {
  if (!scopeSchema) return state
  return z.object(scopeSchema).passthrough().parse(state)
}

export function output<T extends StateSchema, K extends keyof SessionSchema<T> & string>(
  schema: T,
  key: K,
  mode: OutputMode = 'native',
): OutputConfig<T, SessionValue<T, K>> {
  const zodSchema = schema.session?.[key]

  if (
    zodSchema instanceof z.ZodString ||
    zodSchema instanceof z.ZodNumber ||
    zodSchema instanceof z.ZodBoolean
  ) {
    return { key }
  }

  return { key, schema: zodSchema, mode }
}
