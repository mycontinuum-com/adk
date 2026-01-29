import type { StreamEvent, ToolCallEvent } from '../types';

export interface ProducerResult {
  status:
    | 'completed'
    | 'yielded'
    | 'error'
    | 'aborted'
    | 'max_steps'
    | 'transferred';
  iterations: number;
  output?: unknown;
  error?: string;
  pendingCalls?: ToolCallEvent[];
  awaitingInput?: boolean;
}

export interface ChannelResult {
  mainResult?: ProducerResult;
  aborted: boolean;
  abortReason?: string;
  thrownError?: Error;
}

export interface EventChannel {
  registerProducer(): void;
  push(event: StreamEvent): void;
  complete(result?: ProducerResult): void;
  error(err: Error): void;
  events(): AsyncGenerator<StreamEvent, ChannelResult>;
  abort(reason?: string): void;
  registerGenerator?<T>(
    id: string,
    generator: AsyncGenerator<StreamEvent, T>,
    isMain?: boolean,
  ): Promise<{ result?: T; error?: Error }>;
}
