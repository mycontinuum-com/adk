import type { ErrorHandler } from '../errors/types'
import type { Hook } from '../hook/types'
import type { ModelAdapter, Provider, Runnable } from '../types/runnables'
import type { StreamResult, TurnResult } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { SessionService, Input } from '../types/session'

export interface HandlerInput {
  sessionId?: string
  input: Input
}

export interface ResponseConfig {
  events?: boolean
  usage?: boolean
  state?: boolean
}

export interface HandlerConfig<S extends StateSchema = StateSchema> {
  agent: Runnable<S>
  appName: string
  schema?: S
  sessionService?: SessionService
  hooks?: Hook<S>[]
  errorHandlers?: ErrorHandler[]
  timeout?: number
  response?: ResponseConfig
  /**
   * Model adapters the turn's runner resolves before loading a provider package. `app.handler.*`
   * fills this from the app's `adk({ adapters })` registration, so a served turn can run on mock
   * adapters with no provider credentials.
   */
  adapters?: Partial<Record<Provider, ModelAdapter>>
}

export interface TurnStream extends StreamResult<TurnResult> {
  readonly invocationId: string
  readonly sessionId: string
  readonly result: Promise<TurnResult>
}
