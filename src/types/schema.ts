import { z } from 'zod';
import type { OutputConfig, OutputMode } from './runnables';

export type StateSchema = {
  session?: Record<string, z.ZodType>;
  user?: Record<string, z.ZodType>;
  patient?: Record<string, z.ZodType>;
  practice?: Record<string, z.ZodType>;
  temp?: Record<string, z.ZodType>;
};

type InferScope<T> =
  T extends Record<string, z.ZodType>
    ? { [K in keyof T]: z.infer<T[K]> }
    : Record<string, never>;

export type InferStateSchema<T extends StateSchema> = {
  session: InferScope<T['session']>;
  user: InferScope<T['user']>;
  patient: InferScope<T['patient']>;
  practice: InferScope<T['practice']>;
  temp: InferScope<T['temp']>;
};

export type StateValues<T extends StateSchema> = InferScope<T['session']> & {
  session: InferScope<T['session']>;
  user: InferScope<T['user']>;
  patient: InferScope<T['patient']>;
  practice: InferScope<T['practice']>;
  temp: InferScope<T['temp']>;
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
