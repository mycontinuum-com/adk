import type { AnyZodSchema, ZodOutput } from './zod'

export type StateSchema = {
  session?: Record<string, AnyZodSchema>
  user?: Record<string, AnyZodSchema>
  patient?: Record<string, AnyZodSchema>
  practice?: Record<string, AnyZodSchema>
  org?: Record<string, AnyZodSchema>
  team?: Record<string, AnyZodSchema>
  temp?: Record<string, AnyZodSchema>
}

/**
 * Runtime-only marker for APIs that accept a runnable or hook with an arbitrary state schema. Keep
 * concrete state schemas generic at application boundaries; use this only where the runner
 * deliberately erases that schema after construction.
 */
export type ErasedStateSchema = any

export type InferScope<T> = [T] extends [Record<string, AnyZodSchema>]
  ? { [K in keyof T]: ZodOutput<T[K]> }
  : Record<string, unknown>

type InferScopeStrict<T> =
  T extends Record<string, AnyZodSchema>
    ? { [K in keyof T]: ZodOutput<T[K]> }
    : Record<string, never>

export type InferStateSchema<T extends StateSchema> = {
  session: InferScopeStrict<T['session']>
  user: InferScopeStrict<T['user']>
  patient: InferScopeStrict<T['patient']>
  practice: InferScopeStrict<T['practice']>
  org: InferScopeStrict<T['org']>
  team: InferScopeStrict<T['team']>
  temp: InferScopeStrict<T['temp']>
}

type ScopeValues<T> =
  T extends Record<string, AnyZodSchema> ? { [K in keyof T]: ZodOutput<T[K]> } : {}

export type StateValues<T extends StateSchema> = ScopeValues<T['session']> & {
  session: ScopeValues<T['session']>
  user: ScopeValues<T['user']>
  patient: ScopeValues<T['patient']>
  practice: ScopeValues<T['practice']>
  org: ScopeValues<T['org']>
  team: ScopeValues<T['team']>
  temp: ScopeValues<T['temp']>
}

export type ScopeState<T extends Record<string, AnyZodSchema> | undefined> = {
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
    S[K] & (Record<string, AnyZodSchema> | undefined)
  >
}

export type TypedState<S extends StateSchema = StateSchema> = ScopeState<S['session']> & {
  readonly temp: ScopeState<S['temp']>
} & SharedScopeProperties<S>

export function applySchemaDefaults(
  state: Record<string, unknown>,
  scopeSchema?: Record<string, AnyZodSchema>,
): Record<string, unknown> {
  if (!scopeSchema) return state
  const result = { ...state }
  for (const [key, schema] of Object.entries(scopeSchema)) {
    const parsed = schema.safeParse(state[key])
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(`Invalid state field "${key}": ${issue?.message ?? 'validation failed'}`)
    }
    if (parsed.data !== undefined || key in state) result[key] = parsed.data
  }
  return result
}
