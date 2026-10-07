import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import type { Answer, Questions } from '../types/decisions'
import type { StreamEvent, ToolCallEvent } from '../types/events'
import type { ModelAdapter } from '../types/runnables'

import { adk } from '../api/app'
import { DecisionsUnavailableError } from '../errors'
import { gemini, openai } from '../providers/models'
import { serializeContext } from '../providers/openai'
import { createCallId, createEventId } from '../session'
import { MockAdapter } from '../testing'
import { isAnnotationEvent } from '../types/events'

const luna = openai('gpt-6-luna')
const mini = openai('gpt-5.4-mini')

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

  it('passes a refusal through as the answer to its question', async () => {
    const refused = { urgent: { type: 'refusal' } } as const
    const adapter = new MockAdapter({ decisions: refused })
    const app = adk({ adapters: { openai: adapter }, defaultModel: luna })

    await expect(app.decide(INPUT, { questions: urgentOnly })).resolves.toEqual(refused)
  })

  it('answers a question named __proto__ under that name', async () => {
    const name = '__proto__'
    const awkward: Questions = Object.fromEntries([[name, questions.urgent]])
    const adapter = new MockAdapter({ decisions: Object.fromEntries([[name, answered.urgent]]) })
    const app = adk({ adapters: { openai: adapter }, defaultModel: luna })

    const answers = await app.decide(INPUT, { questions: awkward })

    expect(Object.entries(answers)).toEqual([[name, answered.urgent]])
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

  it('rejects with the provider error it was given', async () => {
    const failure = new Error('429 rate limited')
    const app = adk({
      adapters: { openai: decidingAdapter(() => Promise.reject(failure)) },
      defaultModel: luna,
    })

    await expect(app.decide(INPUT, { questions: urgentOnly })).rejects.toBe(failure)
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
      'a score beyond the last level',
      { ...answered, severity: { ...answered.severity, score: questions.severity.levels.length } },
      "Decision answer to 'severity' has a score outside the levels",
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
  ]

  it.each(mismatches)('rejects %s from a custom adapter', async (_case, answers, message) => {
    const app = adk({
      adapters: { openai: decidingAdapter(async () => ({ answers })) },
      defaultModel: luna,
    })

    await expect(app.decide(INPUT, { questions })).rejects.toThrow(message)
  })

  it('rejects a scripted mock answer that does not suit its question', async () => {
    const adapter = new MockAdapter({ decisions: { urgent: answered.department } })
    const app = adk({ adapters: { openai: adapter }, defaultModel: luna })

    await expect(app.decide(INPUT, { questions: urgentOnly })).rejects.toThrow(
      "Decision answer to 'urgent' is a choice, but the question is a predicate",
    )
  })
})

describe('app.decide on a model with no decisions endpoint', () => {
  it('rejects when the adapter has no decisions endpoint, without calling the model', async () => {
    const mock = new MockAdapter({ responses: [{ text: '{"urgent":true}' }] })
    const stepOnly: ModelAdapter = { step: (ctx, config, signal) => mock.step(ctx, config, signal) }
    const model = gemini('gemini-3-flash')
    const app = adk({ adapters: { gemini: stepOnly } })

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
  })
})

describe('what the app hooks see of app.decide', () => {
  it('is one model step of an ephemeral agent, with the usage on its model_end', async () => {
    const seen: StreamEvent[] = []
    const adapter = decidingAdapter(async () => ({ answers: urgentAnswered, usage: USAGE }))
    const app = observedApp(adapter, seen)

    await app.decide(INPUT, { questions: urgentOnly })

    expect(eventSummary(seen)).toEqual([
      'invocation_start',
      'model_start',
      [
        'model_end',
        'decide-ephemeral',
        { ...USAGE, provider: luna.provider, modelName: luna.name },
        undefined,
      ],
      'invocation_end',
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
    expect(eventSummary(seen)).toContainEqual([
      'model_end',
      'decide-ephemeral',
      undefined,
      failure.message,
    ])
  })
})

describe('aborting app.decide', () => {
  it('aborts the decisions endpoint call with the signal and rejects', async () => {
    const aborted = new Error('Request was aborted.')
    const signals: (AbortSignal | undefined)[] = []
    const app = adk({
      adapters: {
        openai: decidingAdapter((_request, _config, signal) => {
          signals.push(signal)
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(aborted))
          })
        }),
      },
      defaultModel: luna,
    })
    const controller = new AbortController()

    const pending = app.decide(INPUT, { questions: urgentOnly, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)

    await expect(pending).rejects.toBe(aborted)
    expect(signals.map((signal) => signal?.aborted)).toEqual([true])
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

  it('leaves one annotation carrying the answers when the hook notes its decision', async () => {
    const noted = { answers: { option: pickAt(CONFIDENT) } }
    const adapter = new MockAdapter({
      decisions: noted.answers,
      responses: [{ text: 'Coffee it is.' }, { text: 'One coffee, coming up.' }],
    })
    const { app, agent } = questionnaire(adapter)

    const result = await app.run(agent, 'Coffee, please.')

    const notes = result.session.events.filter(isAnnotationEvent)
    expect(notes).toMatchObject([{ kind: 'mark', label: 'decision', data: noted }])

    // History alone never shows an annotation to a model; a context renderer has to.
    const barista = app.agent({
      name: 'barista',
      model: mini,
      context: [
        (ctx) => {
          const marks = ctx.session.events
            .filter(isAnnotationEvent)
            .filter((e) => e.label === 'decision')
          const said = `Decisions so far: ${JSON.stringify(marks.map((m) => m.data))}`
          return app.context.system(said)(ctx)
        },
        app.context.history(),
      ],
    })
    await app.run(barista, { session: result.session, input: 'Is my order in?' })

    // The questionnaire's one model call came first; this is the barista's.
    const [system, ...history] = serializeContext(adapter.stepCalls[1].ctx)
    expect(system).toEqual({
      role: 'system',
      content: `Decisions so far: ${JSON.stringify([noted])}`,
    })
    expect(JSON.stringify(history)).not.toContain('probabilities')
  })
})
