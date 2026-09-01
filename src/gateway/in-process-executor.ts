import type { ArtifactService } from '../artifacts/types'
import type { StreamEvent, Event, UserEvent } from '../types/events'
import type { SessionService, SessionStore } from '../types/session'
import type { Executor, ExecutionRequest, ExecutionResult } from './gateway-types'

import { BaseRunner } from '../core/runner'
import { sessionService as createSessionService } from '../session/service'

export interface InProcessExecutorConfig {
  sessionStore: SessionStore
  artifactService?: ArtifactService
}

export class InProcessExecutor implements Executor {
  readonly name = 'in-process'

  private readonly sessionService: SessionService
  private readonly artifactService?: ArtifactService

  constructor(config: InProcessExecutorConfig) {
    this.sessionService = createSessionService(config.sessionStore)
    this.artifactService = config.artifactService
  }

  async execute(
    request: ExecutionRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ExecutionResult> {
    const { session, agent, messages, signal } = request

    for (const msg of messages) {
      const userEvent: UserEvent = {
        type: 'user',
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        createdAt: Date.now(),
        text: typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload),
      }
      await this.sessionService.appendEvent(session, userEvent)
    }

    if (messages.length > 0) {
      await this.sessionService.commitSession(session)
    }

    const runner = new BaseRunner({
      sessionService: this.sessionService,
    })

    const collectedEvents: Event[] = []

    try {
      const stream = runner.run(agent, session, {
        hooks: [
          {
            onEvent: (event: StreamEvent) => {
              collectedEvents.push(event as Event)
              onEvent(event)
            },
          },
        ],
      })

      if (signal.aborted) {
        stream.abort()
        return { status: 'completed', events: collectedEvents }
      }

      signal.addEventListener('abort', () => {
        stream.abort()
      })

      const result = await stream

      await this.sessionService.commitSession(session)

      switch (result.status) {
        case 'completed':
          return { status: 'completed', events: collectedEvents }
        case 'yielded_message':
        case 'yielded_tool':
          return { status: 'sleeping', events: collectedEvents }
        case 'max_steps':
        case 'max_turns':
        case 'max_duration':
        case 'inactivity_timeout':
          return { status: 'sleeping', events: collectedEvents }
        case 'error':
          return {
            status: 'errored',
            error: result.error ?? 'Unknown error',
            events: collectedEvents,
          }
        case 'aborted':
          return { status: 'completed', events: collectedEvents }
        default:
          return { status: 'completed', events: collectedEvents }
      }
    } catch (err) {
      return {
        status: 'errored',
        error: err instanceof Error ? err.message : String(err),
        events: collectedEvents,
      }
    }
  }

  async cleanup(_processId: string): Promise<void> {}
}

export function createInProcessExecutor(config: InProcessExecutorConfig): Executor {
  return new InProcessExecutor(config)
}
