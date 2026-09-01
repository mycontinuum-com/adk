import type { StreamEvent, ToolYieldEvent, Output } from '../types'

export interface ProducerResult {
  status:
    | 'completed'
    | 'yielded_tool'
    | 'yielded_message'
    | 'error'
    | 'aborted'
    | 'max_steps'
    | 'max_turns'
    | 'max_duration'
    | 'inactivity_timeout'
    | 'transferred'
  iterations: number
  output?: Output
  error?: string
  yieldedTools?: ToolYieldEvent[]
  yieldedInvocationId?: string
}

export interface ChannelResult {
  mainResult?: ProducerResult
  aborted: boolean
  abortReason?: string
  thrownError?: Error
}

export interface EventChannel {
  registerProducer(): void
  push(event: StreamEvent): void
  complete(result?: ProducerResult): void
  error(err: Error): void
  events(): AsyncGenerator<StreamEvent, ChannelResult>
  abort(reason?: string): void
  registerGenerator?<T>(
    id: string,
    generator: AsyncGenerator<StreamEvent, T>,
    isMain?: boolean,
  ): Promise<{ result?: T; error?: Error }>
}
