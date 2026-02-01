import { z } from 'zod';
import type {
  Event,
  ModelConfig,
  AssistantEvent,
  UserEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '../../types';
import { agent } from '../../agents';
import { injectSystemMessage, includeHistory } from '../../context';
import { BaseRunner } from '../../core';
import { BaseSession } from '../../session';
import { output, type StateSchema } from '../../types';
import type { Metric, MetricResult } from './types';

const judgmentSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  reasoning: z.string(),
  evidence: z.array(z.string()),
});

type Judgment = z.infer<typeof judgmentSchema>;

export interface LlmJudgeConfig {
  name: string;
  prompt: string;
  model?: ModelConfig;
  passingScore?: number;
  maxRetries?: number;
}

function formatEventsForJudge(events: Event[]): string {
  const lines: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'user':
        lines.push(`[User]: ${(event as UserEvent).text}`);
        break;
      case 'assistant':
        lines.push(`[Assistant]: ${(event as AssistantEvent).text}`);
        break;
      case 'tool_call': {
        const tc = event as ToolCallEvent;
        lines.push(`[Tool Call: ${tc.name}]: ${JSON.stringify(tc.args)}`);
        break;
      }
      case 'tool_result': {
        const tr = event as ToolResultEvent;
        const result = tr.error ?? tr.result;
        lines.push(`[Tool Result: ${tr.name}]: ${JSON.stringify(result)}`);
        break;
      }
    }
  }

  return lines.join('\n');
}

const stateSchema = {
  session: {
    judgment: judgmentSchema,
  },
} satisfies StateSchema;

export function llmJudge(config: LlmJudgeConfig): Metric {
  const passingScore = config.passingScore ?? 0.5;
  const maxRetries = config.maxRetries ?? 2;

  const defaultModel: ModelConfig = {
    provider: 'openai',
    name: 'gpt-4o',
    temperature: 0,
  };

  return {
    name: config.name,
    evaluate: async (events: Event[]): Promise<MetricResult> => {
      const transcript = formatEventsForJudge(events);

      const systemPrompt = `You are an evaluation judge. Your task is to evaluate an AI agent's conversation based on specific criteria.

You will be given:
1. A conversation transcript between a user and an AI agent
2. Evaluation criteria to assess

Respond with a JSON object containing:
- passed: boolean - whether the agent met the criteria
- score: number between 0 and 1 - how well the agent performed (1 = perfect)
- reasoning: string - your explanation for the judgment
- evidence: array of strings - specific quotes or observations that support your judgment

Evaluation Criteria:
${config.prompt}

Conversation Transcript:
${transcript}`;

      const judgeAgent = agent({
        name: 'eval_judge',
        model: config.model ?? defaultModel,
        context: [injectSystemMessage(systemPrompt), includeHistory()],
        output: output(stateSchema, 'judgment'),
      });

      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const session = new BaseSession('eval-judge');
          session.addMessage(
            'Please evaluate the conversation based on the criteria.',
          );

          const runner = new BaseRunner();
          const result = await runner.run(judgeAgent, session);

          const judgment = result.session.state.judgment as
            | Judgment
            | undefined;

          if (!judgment) {
            lastError = new Error(
              'LLM judge failed to produce a valid judgment',
            );
            continue;
          }

          return {
            passed: judgment.passed && judgment.score >= passingScore,
            score: judgment.score,
            value: judgment,
            evidence: [judgment.reasoning, ...judgment.evidence],
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * (attempt + 1)),
            );
          }
        }
      }

      return {
        passed: false,
        evidence: [
          `LLM judge error after ${maxRetries + 1} attempts: ${lastError?.message ?? 'Unknown error'}`,
        ],
      };
    },
  };
}
