import type {
  Event,
  StreamEvent,
  ToolCallEvent,
  ToolResultEvent,
  StateScope,
  Session,
} from '../types';

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeUuid(): R;
      toHaveAssistantText(expected: string | RegExp): R;
      toHaveToolCall(name: string, args?: Record<string, unknown>): R;
      toHaveToolResult(name: string, result?: unknown): R;
      toHaveEventSequence(types: string[]): R;
      toHaveStatus(status: string): R;
      toHaveState(scope: StateScope, key: string, value: unknown): R;
      toHaveEvent(pattern: Partial<Event>): R;
    }
  }
}

function findEventsByType<T extends Event['type']>(
  events: readonly Event[],
  type: T,
): Extract<Event, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<Event, { type: T }>[];
}

function extractEvents(
  received: { events: readonly Event[] } | readonly Event[],
): readonly Event[] {
  if (Array.isArray(received)) {
    return received;
  }
  return (received as { events: readonly Event[] }).events;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const adkMatchers = {
  toBeUuid(received: unknown) {
    const pass = typeof received === 'string' && UUID_REGEX.test(received);
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received} not to be a UUID`
          : `Expected ${received} to be a UUID`,
    };
  },

  toHaveAssistantText(
    received: { events: readonly Event[] } | readonly Event[],
    expected: string | RegExp,
  ) {
    const events = extractEvents(received);
    const assistantEvents = findEventsByType(events, 'assistant');
    const lastAssistant = assistantEvents[assistantEvents.length - 1];

    if (!lastAssistant) {
      return {
        pass: false,
        message: () => 'Expected assistant response but none found',
      };
    }

    const pass =
      typeof expected === 'string'
        ? lastAssistant.text === expected
        : expected.test(lastAssistant.text);

    return {
      pass,
      message: () =>
        pass
          ? `Expected assistant text not to match ${expected}`
          : `Expected assistant text to match ${expected}, got "${lastAssistant.text}"`,
    };
  },

  toHaveToolCall(
    received: { events: readonly Event[] } | readonly Event[],
    name: string,
    args?: Record<string, unknown>,
  ) {
    const events = extractEvents(received);
    const toolCalls = findEventsByType(events, 'tool_call') as ToolCallEvent[];
    const matchingCall = toolCalls.find((tc) => tc.name === name);

    if (!matchingCall) {
      return {
        pass: false,
        message: () =>
          `Expected tool call '${name}' but not found. Found: ${toolCalls.map((tc) => tc.name).join(', ') || 'none'}`,
      };
    }

    if (args) {
      const argsMatch = Object.entries(args).every(
        ([key, value]) => matchingCall.args[key] === value,
      );
      if (!argsMatch) {
        return {
          pass: false,
          message: () =>
            `Expected tool call '${name}' with args ${JSON.stringify(args)}, got ${JSON.stringify(matchingCall.args)}`,
        };
      }
    }

    return {
      pass: true,
      message: () => `Expected no tool call '${name}'`,
    };
  },

  toHaveToolResult(
    received: { events: readonly Event[] } | readonly Event[],
    name: string,
    result?: unknown,
  ) {
    const events = extractEvents(received);
    const toolResults = findEventsByType(
      events,
      'tool_result',
    ) as ToolResultEvent[];
    const matchingResult = toolResults.find((tr) => tr.name === name);

    if (!matchingResult) {
      return {
        pass: false,
        message: () =>
          `Expected tool result for '${name}' but not found. Found: ${toolResults.map((tr) => tr.name).join(', ') || 'none'}`,
      };
    }

    if (result !== undefined) {
      const resultMatches =
        JSON.stringify(matchingResult.result) === JSON.stringify(result);
      if (!resultMatches) {
        return {
          pass: false,
          message: () =>
            `Expected tool result ${JSON.stringify(result)}, got ${JSON.stringify(matchingResult.result)}`,
        };
      }
    }

    return {
      pass: true,
      message: () => `Expected no tool result for '${name}'`,
    };
  },

  toHaveEventSequence(
    received: { events: readonly Event[] } | readonly Event[] | StreamEvent[],
    types: string[],
  ) {
    const events = extractEvents(
      received as { events: readonly Event[] } | readonly Event[],
    );
    const actualTypes = events.map((e) => e.type);
    const filteredActual = actualTypes.filter((t) => types.includes(t));

    const pass = JSON.stringify(filteredActual) === JSON.stringify(types);

    return {
      pass,
      message: () =>
        pass
          ? `Expected event sequence not to be ${types.join(', ')}`
          : `Expected event sequence ${types.join(', ')}, got ${filteredActual.join(', ')}`,
    };
  },

  toHaveStatus(
    received: { status: string } | { result: { status: string } },
    status: string,
  ) {
    const actualStatus =
      'status' in received ? received.status : received.result.status;
    const pass = actualStatus === status;

    return {
      pass,
      message: () =>
        pass
          ? `Expected status not to be '${status}'`
          : `Expected status '${status}', got '${actualStatus}'`,
    };
  },

  toHaveState(
    received:
      | { state: { [key: string]: { get(key: string): unknown } } }
      | Session,
    scope: StateScope,
    key: string,
    value: unknown,
  ) {
    const session = 'state' in received ? received : received;
    const stateAccessor = session.state[scope];
    const actualValue = stateAccessor.get(key);
    const pass = JSON.stringify(actualValue) === JSON.stringify(value);

    return {
      pass,
      message: () =>
        pass
          ? `Expected state.${scope}.${key} not to be ${JSON.stringify(value)}`
          : `Expected state.${scope}.${key} to be ${JSON.stringify(value)}, got ${JSON.stringify(actualValue)}`,
    };
  },

  toHaveEvent(
    received: { events: readonly Event[] } | readonly Event[],
    pattern: Partial<Event>,
  ) {
    const events = extractEvents(received);
    const matchingEvent = events.find((e) => {
      for (const [key, value] of Object.entries(pattern)) {
        const eventValue = (e as unknown as Record<string, unknown>)[key];
        if (value instanceof RegExp) {
          if (typeof eventValue !== 'string' || !value.test(eventValue)) {
            return false;
          }
        } else if (JSON.stringify(eventValue) !== JSON.stringify(value)) {
          return false;
        }
      }
      return true;
    });

    return {
      pass: !!matchingEvent,
      message: () =>
        matchingEvent
          ? `Expected no event matching ${JSON.stringify(pattern)}`
          : `Expected event matching ${JSON.stringify(pattern)} but not found`,
    };
  },
};

export function setupAdkMatchers(): void {
  expect.extend(adkMatchers);
}
