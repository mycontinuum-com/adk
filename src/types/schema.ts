import { z } from 'zod';
import type { OutputConfig, OutputMode } from './runnables';

export type StateSchema = {
  session?: Record<string, z.ZodType>;
  user?: Record<string, z.ZodType>;
  patient?: Record<string, z.ZodType>;
  practice?: Record<string, z.ZodType>;
  temp?: Record<string, z.ZodType>;
};

type InferScope<T> = T extends Record<string, z.ZodType>
  ? { [K in keyof T]: z.infer<T[K]> }
  : Record<string, unknown>;

type InferScopeStrict<T> = T extends Record<string, z.ZodType>
  ? { [K in keyof T]: z.infer<T[K]> }
  : Record<string, never>;

export type InferStateSchema<T extends StateSchema> = {
  session: InferScopeStrict<T['session']>;
  user: InferScopeStrict<T['user']>;
  patient: InferScopeStrict<T['patient']>;
  practice: InferScopeStrict<T['practice']>;
  temp: InferScopeStrict<T['temp']>;
};

type ScopeValues<T> = T extends Record<string, z.ZodType>
  ? { [K in keyof T]: z.infer<T[K]> }
  : Record<string, unknown>;

export type StateValues<T extends StateSchema> = ScopeValues<T['session']> & {
  session: ScopeValues<T['session']>;
  user: ScopeValues<T['user']>;
  patient: ScopeValues<T['patient']>;
  practice: ScopeValues<T['practice']>;
  temp: ScopeValues<T['temp']>;
};

export type ScopeState<T extends Record<string, z.ZodType> | undefined> = {
  [K in keyof InferScope<T>]: InferScope<T>[K] | undefined;
} & {
  update(changes: Partial<{ [K in keyof InferScope<T>]: InferScope<T>[K] | undefined }>): void;
};

export type TypedState<S extends StateSchema = StateSchema> = ScopeState<S['session']> & {
  readonly user: ScopeState<S['user']>;
  readonly patient: ScopeState<S['patient']>;
  readonly practice: ScopeState<S['practice']>;
  readonly temp: ScopeState<S['temp']>;
};

type SessionSchema<T extends StateSchema> = NonNullable<T['session']>;
type SessionValue<T extends StateSchema, K extends keyof SessionSchema<T>> =
  SessionSchema<T>[K] extends z.ZodType<infer U> ? U : never;

export function output<
  T extends StateSchema,
  K extends keyof SessionSchema<T> & string,
>(
  schema: T,
  key: K,
  mode: OutputMode = 'native',
): OutputConfig<SessionValue<T, K>> {
  const zodSchema = schema.session?.[key];

  if (
    zodSchema instanceof z.ZodString ||
    zodSchema instanceof z.ZodNumber ||
    zodSchema instanceof z.ZodBoolean
  ) {
    return { key };
  }

  return { key, schema: zodSchema, mode };
}
