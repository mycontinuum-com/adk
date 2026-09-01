import type { z } from 'zod'

import type {
  StepConfig as BaseStepConfig,
  SequenceConfig,
  ParallelConfig,
  LoopConfig,
} from '../agents/factory'
import type { ErrorHandler } from '../errors/types'
import type {
  ContextRenderer,
  RenderContext,
  FunctionTool,
  ToolExecutionContext,
  RetryConfig,
  Agent,
  Step,
  Sequence,
  Parallel,
  Loop,
  ModelConfig,
  OutputConfig,
  ToolChoice,
  Hook,
  SessionKeyOf,
} from '../types/runnables'
import type { StateSchema } from '../types/schema'
import type { AdkApp } from './app'

export type { SequenceConfig, ParallelConfig, LoopConfig }

export interface ToolConfig<TInput, TOutput, TYield, S extends StateSchema> {
  name: string
  description: string
  schema: z.ZodType<TInput>
  yieldSchema?: z.ZodType<TYield>
  prepare?: (
    ctx: ToolExecutionContext<TInput, unknown, unknown, S>,
  ) => TInput | void | Promise<TInput | void>
  execute?: (ctx: ToolExecutionContext<TInput, TYield, unknown, S>) => TOutput | Promise<TOutput>
  finalize?: (
    ctx: ToolExecutionContext<TInput, TYield, TOutput, S>,
  ) => TOutput | void | Promise<TOutput | void>
  timeout?: number
  retry?: RetryConfig
}

export interface StepConfig<S extends StateSchema> {
  name: string
  description?: string
  execute: BaseStepConfig<S>['execute']
}

type AgentOutput<S extends StateSchema, TOutput> =
  S['session'] extends Record<string, z.ZodType>
    ? SessionKeyOf<S> | OutputConfig<S, TOutput>
    : OutputConfig<S, TOutput>

export interface AgentConfig<S extends StateSchema, TOutput> {
  name: string
  description?: string
  model: ModelConfig
  context: ContextRenderer<S>[]
  tools?: FunctionTool<unknown, unknown, unknown, S>[]
  output?: AgentOutput<S, TOutput>
  toolChoice?: ToolChoice
  maxSteps?: number
  hooks?: Hook<S>[]
  errorHandlers?: ErrorHandler[]
  yields?: boolean
  maxTurns?: number
  timeouts?: import('../types/runnables').AgentTimeouts
}

export type Spec<T, S extends StateSchema = StateSchema> = (app: AdkApp<S>) => T

export type ToolSpec<TInput, TOutput, TYield, S extends StateSchema> = Spec<
  FunctionTool<TInput, TOutput, TYield, S>,
  S
>

export type StepSpec<S extends StateSchema> = Spec<Step<S>, S>
export type ContextSpec<S extends StateSchema> = Spec<ContextRenderer<S>, S>
export type AgentSpec<S extends StateSchema, TOutput> = Spec<Agent<S, TOutput>, S>
export type SequenceSpec<S extends StateSchema> = Spec<Sequence<S>, S>
export type ParallelSpec<S extends StateSchema> = Spec<Parallel<S>, S>
export type LoopSpec<S extends StateSchema> = Spec<Loop<S>, S>

export const spec = {
  tool<S extends StateSchema = StateSchema>(_schema?: S) {
    return <TInput, TOutput, TYield = never>(
      config: ToolConfig<TInput, TOutput, TYield, S>,
    ): ToolSpec<TInput, TOutput, TYield, S> => {
      return (app) =>
        app.tool(
          config as unknown as ToolConfig<TInput, TOutput, TYield, typeof app.schema>,
        ) as unknown as FunctionTool<TInput, TOutput, TYield, S>
    }
  },

  step<S extends StateSchema = StateSchema>(_schema?: S) {
    return (configFn: (app: AdkApp<S>) => StepConfig<S>): StepSpec<S> => {
      return (app) => {
        const config = configFn(app as unknown as AdkApp<S>)
        return app.step(
          config as unknown as BaseStepConfig<typeof app.schema>,
        ) as unknown as Step<S>
      }
    }
  },

  context<S extends StateSchema = StateSchema>(_schema?: S) {
    return (render: ContextRenderer<S>): ContextSpec<S> => {
      return (app) =>
        ((ctx: RenderContext<typeof app.schema>) =>
          render(ctx as unknown as RenderContext<S>) as unknown as RenderContext<
            typeof app.schema
          >) as unknown as ContextRenderer<S>
    }
  },

  agent<S extends StateSchema = StateSchema>(_schema?: S) {
    return <TOutput = unknown>(
      configFn: (app: AdkApp<S>) => AgentConfig<S, TOutput>,
    ): AgentSpec<S, TOutput> => {
      return (app) => {
        const config = configFn(app as unknown as AdkApp<S>)
        return app.agent(
          config as unknown as AgentConfig<typeof app.schema, TOutput>,
        ) as unknown as Agent<S, TOutput>
      }
    }
  },

  sequence<S extends StateSchema = StateSchema>(_schema?: S) {
    return (configFn: (app: AdkApp<S>) => SequenceConfig<S>): SequenceSpec<S> => {
      return (app) => {
        const config = configFn(app as unknown as AdkApp<S>)
        return app.sequence(
          config as unknown as SequenceConfig<typeof app.schema>,
        ) as unknown as Sequence<S>
      }
    }
  },

  parallel<S extends StateSchema = StateSchema>(_schema?: S) {
    return (configFn: (app: AdkApp<S>) => ParallelConfig<S>): ParallelSpec<S> => {
      return (app) => {
        const config = configFn(app as unknown as AdkApp<S>)
        return app.parallel(
          config as unknown as ParallelConfig<typeof app.schema>,
        ) as unknown as Parallel<S>
      }
    }
  },

  loop<S extends StateSchema = StateSchema>(_schema?: S) {
    return (configFn: (app: AdkApp<S>) => LoopConfig<S>): LoopSpec<S> => {
      return (app) => {
        const config = configFn(app as unknown as AdkApp<S>)
        return app.loop(config as unknown as LoopConfig<typeof app.schema>) as unknown as Loop<S>
      }
    }
  },
}
