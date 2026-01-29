import type { ThoughtDeltaEvent, AssistantDeltaEvent } from '../types';

export type RawDeltaEvent =
  | Omit<ThoughtDeltaEvent, 'text'>
  | Omit<AssistantDeltaEvent, 'text'>;

export interface AccumulatedText {
  thoughtText: string;
  assistantText: string;
}

export interface StreamAccumulator {
  push(event: RawDeltaEvent): ThoughtDeltaEvent | AssistantDeltaEvent;
  getAccumulatedText(): AccumulatedText;
}

export function createStreamAccumulator(): StreamAccumulator {
  let thoughtText = '';
  let assistantText = '';

  return {
    push(event) {
      if (event.type === 'thought_delta') {
        thoughtText += event.delta;
        return { ...event, text: thoughtText } as ThoughtDeltaEvent;
      } else {
        assistantText += event.delta;
        return { ...event, text: assistantText } as AssistantDeltaEvent;
      }
    },

    getAccumulatedText() {
      return { thoughtText, assistantText };
    },
  };
}
