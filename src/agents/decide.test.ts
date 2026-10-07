import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import type { Answer } from '../types/decisions'
import type { StreamEvent, ToolCallEvent } from '../types/events'
import type { ModelAdapter, ModelStepResult, ProviderModelConfig } from '../types/runnables'

import { adk } from '../api/app'
import { DecisionsUnavailableError, retryHandler } from '../errors'
import { chatCompletions } from '../integrations/chat-completions'
import { gemini, openai } from '../providers/models'
import { createCallId, createEventId } from '../session'
import { MockAdapter } from '../testing'
import { isAnnotationEvent } from '../types/events'

const luna = openai('gpt-6-luna')
const mini = openai('gpt-5.4-mini')
const ADAPTER_NAME = 'custom'
const named = chatCompletions('local-model', { adapter: ADAPTER_NAME })

const INPUT = 'I was charged twice.'
const questions = {
  urgent: { type: 'predicate', instructions: 'Is the caller describing an emergency?' },
  department: {
    type: 'choice',
    instructions: 'Which department should take this?',
    choices: [{ value: 'billing', description: 'Payments and refunds.' }, { value: 'technical' }],
  },
  severity: {
    type: 'score',
    instructions: 'How severe is the problem?',
    levels: [{ label: 'Cosmetic' }, { label: 'Workaround' }, { label: 'Blocked' }],
  },
} as const
const urgentOnly = { urgent: questions.urgent }
const answered = {
  urgent: { type: 'predicate', probability: 0.02 },
  department: {
    type: 'choice',
    choice: 'billing',
    confidence: 0.93,
    probabilities: [
      { value: 'billing', probability: 0.95 },
      { value: 'technical', probability: 0.05 },
    ],
  },
  severity: { type: 'score', score: 1.1, confidence: 0.55 },
} satisfies Record<keyof typeof questions, Answer>
const urgentAnswered = { urgent: answered.urgent }
const [billingProbability] = answered.department.probabilities
const LAST_LEVEL = questions.severity.levels.length - 1
const NOT_ONE_EACH =
  "Decision answer to 'department' does not give exactly one probability for each value offered"
const SCORE_OUTSIDE = "Decision answer to 'severity' has a score outside the levels"
const USAGE = { inputTokens: 395, outputTokens: 0, cachedTokens: 0 }

const SUBMIT_ANSWER = 'submit_answer'
const CALLER_PICK = 'coffee'
const MODEL_PICK = 'tea'
const NO_PICK = 'none'
const CONFIDENT = 0.97
const UNSURE = 0.4
const SURE_ENOUGH = 0.9
const drinkQuestion = {
  type: 'choice',
  instructions: 'Which option did the caller choose?',
  choices: [{ value: MODEL_PICK }, { value: CALLER_PICK }, { value: NO_PICK }],
} as const
const drinkSchema = { session: { picked: z.string().optional() } }

/** An adapter whose decisions endpoint answers as `decide` says and whose model is never called. */
function decidingAdapter(decide: NonNullable<ModelAdapter['decide']>): ModelAdapter {
  return {
    async *step() {
      throw new Error('the model was called')
    },
    decide,
  }
}

/** An app on the decisions model whose hooks collect every event into `seen`. */
function observedApp(adapter: ModelAdapter, seen: StreamEvent[]) {
  return adk({
    adapters: { openai: adapter },
    defaultModel: luna,
    hooks: [{ onEvent: (event) => seen.push(event) }],
  })
}

/** Each event's type, with what a `model_end` reports of its call. */
function eventSummary(events: StreamEvent[]) {
  return events.map((e) =>
    e.type === 'model_end' ? [e.type, e.agentName, e.usage, e.error] : e.type,
  )
}

/** The caller's pick, held with the given confidence. */
function pickAt(confidence: number): Answer<typeof drinkQuestion> {
  return {
    type: 'choice',
    choice: CALLER_PICK,
    confidence,
    probabilities: [
      { value: MODEL_PICK, probability: (1 - confidence) / 2 },
      { value: CALLER_PICK, probability: confidence },
      { value: NO_PICK, probability: (1 - confidence) / 2 },
    ],
  }
}

/** A call to the answer tool, as the model would have made it. */
function submitCall(invocationId: string, agentName: string, optionId: string): ToolCallEvent {
  return {
    id: createEventId(),
    type: 'tool_call',
    createdAt: Date.now(),
    invocationId,
    agentName,
    callId: createCallId(),
    name: SUBMIT_ANSWER,
    args: { optionId },
  }
}

/**
 * An agent whose `beforeModel` hook decides which option the caller chose, notes the decision, and
 * submits the answer itself when the decision is confident.
 */
function questionnaire(adapter: MockAdapter) {
  const app = adk({ schema: drinkSchema, adapters: { openai: adapter } })
  const agent = app.agent({
    name: 'questionnaire',
    model: mini,
    context: [app.context.history()],
    tools: [
      app.tool({
        name: SUBMIT_ANSWER,
        description: 'Record the option the caller chose.',
        schema: z.object({ optionId: z.string() }),
        execute: (ctx) => {
          ctx.state.picked = ctx.args.optionId
          return { recorded: ctx.args.optionId }
        },
      }),
    ],
    hooks: [
      {
        beforeModel: async (ctx, renderCtx) => {
          if (ctx.state.picked) return
          const { option } = await app.decide('agent: Tea or coffee?\ncaller: Coffee, please.', {
            model: luna,
            signal: ctx.signal,
            questions: { option: drinkQuestion },
          })
          ctx.note('decision', { kind: 'mark', label: 'decision', data: { answers: { option } } })
          if (option.type !== 'choice' || option.choice === NO_PICK) return
          if (option.confidence < SURE_ENOUGH) return
          const call = submitCall(ctx.invocationId, renderCtx.agentName, option.choice)
          return { stepEvents: [call], toolCalls: [call], terminal: false }
        },
      },
    ],
  })
  return { app, agent }
}

describe('app.decide on a decisions endpoint', () => {
  it('returns each scripted answer under its question name', async () => {
    const adapter = new MockAdapter({ decisions: answered })
    const app = adk({ adapters: { openai: adapter }, defaultModel: luna })

    const answers = await app.decide(INPUT, { questions })

    expect(answers).toEqual(answered)
    expect(adapter.decideCalls).toEqual([{ request: { input: INPUT, questions }, config: luna }])
    expect(adapter.stepCalls).toHaveLength(0)
  })

  it('uses opts.model over the default model', async () => {
    const adapter = new MockAdapter({ decisions: urgentAnswered })
    const app = adk({ adapters: { openai: adapter }, defaultModel: mini })

    await app.decide(INPUT, { questions: urgentOnly, model: luna })

    expect(adapter.decideCalls.map((call) => call.config)).toEqual([luna])
  })

  it('asks the adapter registered under the name the model gives', async () => {
    const adapter = new MockAdapter({ decisions: urgentAnswered })
    const app = adk({ adapters: { [ADAPTER_NAME]: adapter } })

    const answers = await app.decide(INPUT, { questions: urgentOnly, model: named })

    expect(answers).toEqual(urgentAnswered)
    expect(adapter.decideCalls).toEqual([
      { request: { input: INPUT, questions: urgentOnly }, config: named },
    ])
  })

  it('passes a refusal through as the answer to its question', async () => {
    const refused = { urgent: { type: 'refusal' } } as const
    const adapter = new MockAdapter({ decisions: refused })
    const app = adk({ adapters: { openai: adapter }, defaultModel: luna })

    await expect(app.decide(INPUT, { questions: urgentOnly })).resolves.toEqual(refused)
  })

  it('fails when the mock has no scripted answer for a question', async () => {
    const adapter = new MockAdapter({ decisions: urgentAnswered })
    const app = adk({ adapters: { openai: adapter }, defaultModel: luna })

    await expect(app.decide(INPUT, { questions })).rejects.toThrow(
      'MockAdapter has no scripted decision for: department, severity',
    )
  })

  it('fails without a model, before any call', async () => {
    const adapter = new MockAdapter({ decisions: urgentAnswered })
    const app = adk({ adapters: { openai: adapter } })

    await expect(app.decide(INPUT, { questions: urgentOnly })).rejects.toThrow(
      '[adk] app.decide: no model configured. Pass opts.model or set defaultModel in adk({ defaultModel }).',
    )
    expect(adapter.decideCalls).toHaveLength(0)
  })
})

describe('app.decide given answers that do not match the questions', () => {
  const mismatches: [string, Record<string, Answer>, string][] = [
    [
      'an answer of another question type',
      { ...answered, urgent: answered.severity },
      "Decision answer to 'urgent' is a score, but the question is a predicate",
    ],
    [
      'a choice the question does not offer',
      { ...answered, department: { ...answered.department, choice: 'sales' } },
      "Decision answer to 'department' chooses a value the question does not offer",
    ],
    [
      'a probability above 1',
      { ...answered, urgent: { ...answered.urgent, probability: 1.2 } },
      "Decision answer to 'urgent' has a probability outside 0 to 1",
    ],
    [
      'a confidence above 1',
      { ...answered, department: { ...answered.department, confidence: 1.5 } },
      "Decision answer to 'department' has a confidence outside 0 to 1",
    ],
    [
      'a probability for a value that was not offered',
      {
        ...answered,
        department: {
          ...answered.department,
          probabilities: [billingProbability, { value: 'sales', probability: 0.05 }],
        },
      },
      NOT_ONE_EACH,
    ],
    [
      'no probability for an offered value',
      { ...answered, department: { ...answered.department, probabilities: [billingProbability] } },
      NOT_ONE_EACH,
    ],
    [
      'two probabilities for one value',
      {
        ...answered,
        department: {
          ...answered.department,
          probabilities: [...answered.department.probabilities, billingProbability],
        },
      },
      NOT_ONE_EACH,
    ],
    [
      'a score below the first level',
      { ...answered, severity: { ...answered.severity, score: -0.01 } },
      SCORE_OUTSIDE,
    ],
    [
      'a score above the last level',
      { ...answered, severity: { ...answered.severity, score: LAST_LEVEL + 0.01 } },
      SCORE_OUTSIDE,
    ],
    [
      'no answer to a question',
      { urgent: answered.urgent, department: answered.department },
      "Decision has no answer to 'severity'",
    ],
    [
      'an answer to a question that was not asked',
      { ...answered, extra: answered.urgent },
      "Decision has an answer to 'extra', which was not asked",
    ],
    [
      'an answer under a name every object inherits',
      { ...answered, toString: answered.urgent },
      "Decision has an answer to 'toString', which was not asked",
    ],
  ]

  it.each(mismatches)('rejects %s', async (_case, answers, message) => {
    const app = adk({
      adapters: { openai: decidingAdapter(async () => ({ answers })) },
      defaultModel: luna,
    })

    await expect(app.decide(INPUT, { questions })).rejects.toThrow(message)
  })

  it.each([0, LAST_LEVEL])('accepts a score of %d, an end level', async (score) => {
    const answers = { ...answered, severity: { ...answered.severity, score } }
    const app = adk({
      adapters: { openai: decidingAdapter(async () => ({ answers })) },
      defaultModel: luna,
    })

    await expect(app.decide(INPUT, { questions })).resolves.toEqual(answers)
  })
})

describe('app.decide on a model with no decisions endpoint', () => {
  const unserved: [string, ProviderModelConfig, string][] = [
    ['its provider', gemini('gemini-3-flash'), 'gemini'],
    ['a name', named, ADAPTER_NAME],
  ]

  it.each(unserved)(
    'rejects when the adapter registered under %s has none, without calling the model',
    async (_case, model, key) => {
      const mock = new MockAdapter({ responses: [{ text: '{"urgent":true}' }] })
      const stepOnly: ModelAdapter = {
        step: (ctx, config, signal) => mock.step(ctx, config, signal),
      }
      const app = adk({ adapters: { [key]: stepOnly } })

      const rejection = await app
        .decide(INPUT, { questions: urgentOnly, model })
        .catch((error: unknown) => error)

      expect(rejection).toBeInstanceOf(DecisionsUnavailableError)
      expect(rejection).toMatchObject({
        name: 'DecisionsUnavailableError',
        provider: model.provider,
        modelName: model.name,
        message: `Decisions are not available for model '${model.name}' (${model.provider}): no decisions endpoint serves it`,
      })
      expect(mock.stepCalls).toHaveLength(0)
    },
  )
})

describe('a DecisionsUnavailableError from another copy of the class', () => {
  it('is an instance of the class the package exports', async () => {
    class BundledCopy extends Error {
      override name = 'DecisionsUnavailableError'
    }
    const thrown = new BundledCopy('no decisions endpoint serves it')
    const app = adk({
      adapters: { openai: decidingAdapter(() => Promise.reject(thrown)) },
      defaultModel: luna,
    })

    const rejection = await app
      .decide(INPUT, { questions: urgentOnly })
      .catch((error: unknown) => error)

    expect(rejection).toBe(thrown)
    expect(rejection).toBeInstanceOf(DecisionsUnavailableError)
    expect(new Error(thrown.message)).not.toBeInstanceOf(DecisionsUnavailableError)
  })
})

describe('what the app hooks see of app.decide', () => {
  it('is one model call, with the usage on its model_end', async () => {
    const seen: StreamEvent[] = []
    const adapter = decidingAdapter(async () => ({ answers: urgentAnswered, usage: USAGE }))
    const app = observedApp(adapter, seen)

    await app.decide(INPUT, { questions: urgentOnly })

    expect(eventSummary(seen)).toEqual([
      'model_start',
      [
        'model_end',
        'decide',
        { ...USAGE, provider: luna.provider, modelName: luna.name },
        undefined,
      ],
    ])
    expect(JSON.stringify(seen)).not.toContain(INPUT)
    expect(JSON.stringify(seen)).not.toContain(questions.urgent.instructions)
  })

  it('records a failed decision as a model call without usage', async () => {
    const seen: StreamEvent[] = []
    const failure = new Error('503 unavailable')
    const app = observedApp(
      decidingAdapter(() => Promise.reject(failure)),
      seen,
    )

    await expect(app.decide(INPUT, { questions: urgentOnly })).rejects.toBe(failure)
    expect(eventSummary(seen)).toEqual([
      'model_start',
      ['model_end', 'decide', undefined, failure.message],
    ])
  })

  it('runs no agent, so a hook that answers model steps does not answer it', async () => {
    const ran: string[] = []
    const hookAnswer: ModelStepResult = { stepEvents: [], toolCalls: [], terminal: true }
    const app = adk({
      adapters: { openai: new MockAdapter({ decisions: urgentAnswered }) },
      defaultModel: luna,
      hooks: [
        {
          beforeAgent: () => {
            ran.push('beforeAgent')
          },
          beforeModel: () => {
            ran.push('beforeModel')
            return hookAnswer
          },
        },
      ],
    })

    await expect(app.decide(INPUT, { questions: urgentOnly })).resolves.toEqual(urgentAnswered)
    expect(ran).toEqual([])
  })

  it('is not retried by an app error handler', async () => {
    const failure = new Error('503 unavailable')
    let calls = 0
    const app = adk({
      adapters: {
        openai: decidingAdapter(() => {
          calls += 1
          return Promise.reject(failure)
        }),
      },
      defaultModel: luna,
      errorHandlers: [retryHandler({ baseDelay: 1 })],
    })

    await expect(app.decide(INPUT, { questions: urgentOnly })).rejects.toBe(failure)
    expect(calls).toBe(1)
  })
})

describe('aborting app.decide', () => {
  it('aborts the decisions endpoint call with the signal and rejects', async () => {
    const aborted = new Error('Request was aborted.')
    const controller = new AbortController()
    const app = adk({
      adapters: {
        openai: decidingAdapter((_request, _config, signal) => {
          const call = new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(aborted))
          })
          controller.abort()
          return call
        }),
      },
      defaultModel: luna,
    })

    const pending = app.decide(INPUT, { questions: urgentOnly, signal: controller.signal })

    await expect(pending).rejects.toBe(aborted)
  })

  it('rejects for a signal aborted before the call, without asking the adapter', async () => {
    const seen: StreamEvent[] = []
    let calls = 0
    const app = observedApp(
      decidingAdapter(async () => {
        calls += 1
        return { answers: urgentAnswered }
      }),
      seen,
    )
    const reason = new Error('The caller hung up.')
    const controller = new AbortController()
    controller.abort(reason)

    const pending = app.decide(INPUT, { questions: urgentOnly, signal: controller.signal })

    await expect(pending).rejects.toBe(reason)
    expect(calls).toBe(0)
    expect(eventSummary(seen)).toEqual([
      'model_start',
      ['model_end', 'decide', undefined, reason.message],
    ])
  })

  it('rejects when the signal is aborted during the call and the adapter ignores it', async () => {
    const controller = new AbortController()
    const app = adk({
      adapters: {
        openai: decidingAdapter(async () => {
          controller.abort()
          return { answers: urgentAnswered }
        }),
      },
      defaultModel: luna,
    })

    const rejection: unknown = await app
      .decide(INPUT, { questions: urgentOnly, signal: controller.signal })
      .catch((error: unknown) => error)

    expect(rejection).toBe(controller.signal.reason)
    expect(rejection).toMatchObject({ name: 'AbortError' })
  })
})

describe('app.decide in a beforeModel hook', () => {
  it('skips the model and runs the tool on a confident choice', async () => {
    const adapter = new MockAdapter({
      decisions: { option: pickAt(CONFIDENT) },
      responses: [{ text: 'Coffee it is.' }],
    })
    const { app, agent } = questionnaire(adapter)

    const result = await app.run(agent, 'Coffee, please.')

    expect(result.state.picked).toBe(CALLER_PICK)
    expect(result.session.events.flatMap((e) => (e.type === 'tool_call' ? [e.args] : []))).toEqual([
      { optionId: CALLER_PICK },
    ])
    // The only model call is the reply after the tool ran; the choice itself never reached it.
    expect(adapter.stepCalls).toHaveLength(1)
    expect(adapter.decideCalls).toHaveLength(1)
    expect(result.session.events.filter(isAnnotationEvent)).toMatchObject([
      { kind: 'mark', label: 'decision', data: { answers: { option: pickAt(CONFIDENT) } } },
    ])
  })

  it('falls through to the model on an unconfident choice', async () => {
    const adapter = new MockAdapter({
      decisions: { option: pickAt(UNSURE) },
      responses: [
        { toolCalls: [{ name: SUBMIT_ANSWER, args: { optionId: MODEL_PICK } }] },
        { text: 'Tea it is.' },
      ],
    })
    const { app, agent } = questionnaire(adapter)

    const result = await app.run(agent, 'Coffee, please.')

    expect(result.state.picked).toBe(MODEL_PICK)
    expect(adapter.stepCalls).toHaveLength(2)
    expect(adapter.decideCalls).toHaveLength(1)
  })
})
