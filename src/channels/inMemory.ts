import type { StreamEvent } from '../types';
import type { EventChannel, ProducerResult, ChannelResult } from './types';

interface Producer {
  isMain: boolean;
  status: 'active' | 'completed' | 'error';
  result?: ProducerResult;
  resolve?: (value: { result?: unknown; error?: Error }) => void;
}

interface QueuedItem {
  type: 'event' | 'complete' | 'error' | 'abort';
  producerId: string;
  isMain?: boolean;
  event?: StreamEvent;
  result?: ProducerResult;
  error?: string;
  abortReason?: string;
}

export class InMemoryChannel implements EventChannel {
  private queue: QueuedItem[] = [];
  private producers = new Map<string, Producer>();
  private mainProducerId?: string;
  private closed = false;
  private aborted = false;
  private abortReason?: string;
  private directProducerCount = 0;
  private waitingResolve?: () => void;

  constructor() {}

  private notify(): void {
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = undefined;
      resolve();
    }
  }

  registerProducer(): void {
    this.directProducerCount++;
  }

  push(event: StreamEvent): void {
    if (this.closed || this.aborted) return;
    this.queue.push({ type: 'event', producerId: '__direct__', event });
    this.notify();
  }

  complete(result?: ProducerResult): void {
    this.directProducerCount = Math.max(0, this.directProducerCount - 1);
    if (result) {
      this.queue.push({
        type: 'complete',
        producerId: '__direct__',
        isMain: false,
        result,
      });
      this.notify();
    }
  }

  error(err: Error): void {
    this.queue.push({
      type: 'error',
      producerId: '__direct__',
      isMain: false,
      error: err.message,
    });
    this.closed = true;
    this.notify();
  }

  abort(reason?: string): void {
    this.aborted = true;
    this.abortReason = reason ?? 'Aborted';
    this.queue.push({
      type: 'abort',
      producerId: '__system__',
      abortReason: this.abortReason,
    });
    this.notify();
  }

  registerGenerator<T>(
    id: string,
    generator: AsyncGenerator<StreamEvent, T>,
    isMain: boolean = false,
  ): Promise<{ result?: T; error?: Error }> {
    if (this.closed || this.aborted) {
      return Promise.resolve({ error: new Error('Channel closed') });
    }

    return new Promise((resolve) => {
      const producer: Producer = {
        isMain,
        status: 'active',
        resolve: resolve as Producer['resolve'],
      };
      this.producers.set(id, producer);
      if (isMain) this.mainProducerId = id;

      this.runProducer(id, generator, isMain);
    });
  }

  private async runProducer<T>(
    id: string,
    generator: AsyncGenerator<StreamEvent, T>,
    isMain: boolean,
  ): Promise<void> {
    const producer = this.producers.get(id)!;

    try {
      let iterResult = await generator.next();
      while (!iterResult.done) {
        if (this.aborted) {
          await generator.return?.(undefined as T);
          break;
        }
        this.queue.push({
          type: 'event',
          producerId: id,
          event: iterResult.value,
        });
        this.notify();
        iterResult = await generator.next();
      }

      producer.status = 'completed';
      producer.result = iterResult.value as ProducerResult;

      this.queue.push({
        type: 'complete',
        producerId: id,
        isMain,
        result: iterResult.value as ProducerResult,
      });
      this.notify();
      producer.resolve?.({ result: iterResult.value as T });
    } catch (error) {
      producer.status = 'error';

      const err = error instanceof Error ? error : new Error(String(error));
      this.queue.push({
        type: 'error',
        producerId: id,
        isMain,
        error: err.message,
      });
      this.notify();
      producer.resolve?.({ error: err });
    }
  }

  private checkAllComplete(completedProducers: Set<string>): boolean {
    if (this.directProducerCount > 0) return false;
    if (this.producers.size === 0) return true;
    return [...this.producers.keys()].every((id) => completedProducers.has(id));
  }

  async *events(): AsyncGenerator<StreamEvent, ChannelResult> {
    let mainResult: ProducerResult | undefined;
    let thrownError: Error | undefined;
    const completedProducers = new Set<string>();
    let queueIndex = 0;

    while (!this.closed && !this.aborted) {
      if (thrownError) break;

      while (queueIndex < this.queue.length) {
        const item = this.queue[queueIndex++];

        switch (item.type) {
          case 'abort':
            this.aborted = true;
            this.abortReason = item.abortReason;
            return {
              mainResult,
              aborted: true,
              abortReason: this.abortReason,
            };

          case 'error':
            completedProducers.add(item.producerId);
            if (item.isMain) {
              thrownError = new Error(item.error);
              this.closed = true;
            }
            if (this.checkAllComplete(completedProducers)) {
              this.closed = true;
            }
            break;

          case 'complete':
            completedProducers.add(item.producerId);
            if (item.isMain && item.result) {
              mainResult = item.result;
              if (mainResult.status === 'yielded') {
                this.closed = true;
              }
            }
            if (this.checkAllComplete(completedProducers)) {
              this.closed = true;
            }
            break;

          case 'event':
            if (item.event) {
              yield item.event;
            }
            break;
        }
      }

      if (!this.closed && !this.aborted) {
        if (this.checkAllComplete(completedProducers)) {
          this.closed = true;
        } else {
          await new Promise<void>((resolve) => {
            this.waitingResolve = resolve;
          });
        }
      }
    }

    return {
      mainResult,
      aborted: this.aborted,
      abortReason: this.abortReason,
      thrownError,
    };
  }

  async cleanup(): Promise<void> {
    this.producers.clear();
    this.queue = [];
    this.closed = true;
  }
}

export function createInMemoryChannel(): EventChannel {
  return new InMemoryChannel();
}
