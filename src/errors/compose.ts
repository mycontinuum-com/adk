import type { ErrorContext } from '../types/events';
import type {
  ErrorHandler,
  ErrorRecovery,
  ComposedErrorHandler,
} from './types';

export function composeErrorHandlers(
  runnerHandlers: readonly ErrorHandler[],
  agentHandlers: readonly ErrorHandler[],
): ComposedErrorHandler {
  const allHandlers = [...runnerHandlers, ...agentHandlers];

  return {
    async handle(ctx: ErrorContext): Promise<ErrorRecovery> {
      for (const handler of allHandlers) {
        if (handler.canHandle) {
          const canHandle = await handler.canHandle(ctx);
          if (!canHandle) continue;
        }

        const recovery = await handler.handle(ctx);

        if (recovery.action !== 'pass') {
          return recovery;
        }
      }

      return defaultRecovery(ctx);
    },
  };
}

function defaultRecovery(ctx: ErrorContext): ErrorRecovery {
  return ctx.phase === 'tool' ? { action: 'skip' } : { action: 'throw' };
}
