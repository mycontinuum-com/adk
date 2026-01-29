import type { Session, Event, AssistantEvent } from '../types';
import type {
  Bridge,
  YieldInfo,
  StateChanges,
  StateChangeResult,
} from './types';
import { STATE_CHANGE_MARKER, isStateChangeResult } from './types';

export function withStateChange<T>(
  result: T,
  stateChanges: StateChanges,
): StateChangeResult<T> {
  return {
    [STATE_CHANGE_MARKER]: true,
    result,
    stateChanges,
  };
}

export function unwrapStateChange<T>(value: T | StateChangeResult<T>): T {
  if (isStateChangeResult(value)) {
    return value.result;
  }
  return value;
}

export function collectStateChanges(results: unknown[]): StateChanges {
  const collected: StateChanges = {};

  for (const result of results) {
    if (!isStateChangeResult(result)) continue;

    const changes = result.stateChanges;

    if (changes.session) {
      collected.session = { ...collected.session, ...changes.session };
    }
    if (changes.user) {
      collected.user = { ...collected.user, ...changes.user };
    }
    if (changes.patient) {
      collected.patient = { ...collected.patient, ...changes.patient };
    }
    if (changes.practice) {
      collected.practice = { ...collected.practice, ...changes.practice };
    }
  }

  return collected;
}

function getLastAssistantText(session: Session): string {
  const events = session.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'assistant') {
      return (event as AssistantEvent).text;
    }
  }
  return '';
}

export function defaultFormatPrompt(
  mainSession: Session,
  yieldInfo: YieldInfo,
): string {
  if (yieldInfo.type === 'loop') {
    return getLastAssistantText(mainSession);
  }

  return `Tool: ${yieldInfo.toolName}\nArgs: ${JSON.stringify(yieldInfo.args)}`;
}

export function defaultFormatResponse(
  output: unknown,
  userAgentSession: Session,
  yieldInfo: YieldInfo,
): unknown {
  if (output !== undefined && output !== null) {
    return output;
  }

  return getLastAssistantText(userAgentSession);
}

export const defaultBridge: Required<Bridge> = {
  formatPrompt: defaultFormatPrompt,
  formatResponse: defaultFormatResponse,
};

export function createBridge(custom?: Bridge): Required<Bridge> {
  return {
    formatPrompt: custom?.formatPrompt ?? defaultFormatPrompt,
    formatResponse: custom?.formatResponse ?? defaultFormatResponse,
  };
}
