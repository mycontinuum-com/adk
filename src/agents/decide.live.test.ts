import { assert, describe, expect, it } from 'vitest'

import type { StreamEvent } from '../types/events'

import { adk } from '../api/app'
import { DecisionsUnavailableError } from '../errors'
import { openai } from '../providers/models'

// Calls the paid OpenAI API, so it runs only on explicit opt-in: never in CI or a plain test run.
const RUN_LIVE =
  process.env.ADK_RUN_DECIDE_LIVE === '1' &&
  Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_EU_API_KEY)

const luna = openai('gpt-6-luna')
const unserved = openai('gpt-5.4-mini', { reasoning: { effort: 'low' } })
const greeting = { type: 'predicate', instructions: 'Is the text a greeting?' } as const
const department = {
  type: 'choice',
  instructions: 'Which department should handle this?',
  choices: [
    { value: 'billing', description: 'Payments, invoices and refunds.' },
    { value: 'technical', description: 'Problems using the product.' },
    { value: 'other', description: 'Anything else.' },
  ],
} as const
const severity = {
  type: 'score',
  instructions: 'How severe is this issue for the customer?',
  levels: [
    { label: 'Cosmetic', description: 'Appearance only; nothing is lost.' },
    { label: 'Workaround available', description: 'A task fails, but another way works.' },
    { label: 'Fully blocked', description: 'A task fails with no workaround.' },
  ],
} as const

;(RUN_LIVE ? describe : describe.skip)('app.decide against the live OpenAI API', () => {
  const seen: StreamEvent[] = []
  const app = adk({ defaultModel: luna, hooks: [{ onEvent: (event) => seen.push(event) }] })

  it('answers a predicate with a probability', async () => {
    const answers = await app.decide('Hello there, good morning!', { questions: { greeting } })

    assert(answers.greeting.type === 'predicate')
    expect(answers.greeting.probability).toBeGreaterThan(0.8)
  })

  it('answers a choice with a value, a confidence and a probability per value', async () => {
    const answers = await app.decide('I was charged twice for my order.', {
      questions: { department },
    })

    assert(answers.department.type === 'choice')
    expect(answers.department.choice).toBe(department.choices[0].value)
    expect(answers.department.confidence).toBeGreaterThan(0.5)
    expect(answers.department.probabilities.map((p) => p.value)).toEqual(
      department.choices.map((c) => c.value),
    )
  })

  it('answers a score with a position on the levels', async () => {
    const answers = await app.decide('Nobody can log in and there is no other way in.', {
      questions: { severity },
    })

    assert(answers.severity.type === 'score')
    expect(answers.severity.score).toBeGreaterThan(1.5)
    expect(answers.severity.score).toBeLessThanOrEqual(severity.levels.length - 1)
    expect(answers.severity.confidence).toBeGreaterThan(0)
  })

  it('answers several questions in one request and reports its usage in one event', async () => {
    seen.length = 0

    const answers = await app.decide('Hello, I was charged twice and cannot log in at all.', {
      questions: { greeting, department, severity },
    })

    expect(Object.entries(answers).map(([name, answer]) => [name, answer.type])).toEqual([
      ['greeting', 'predicate'],
      ['department', 'choice'],
      ['severity', 'score'],
    ])
    const calls = seen.filter((e) => e.type === 'model_end')
    expect(calls).toMatchObject([
      {
        agentName: 'decide-ephemeral',
        usage: { provider: luna.provider, modelName: luna.name, outputTokens: 0 },
      },
    ])
    expect(calls[0].usage?.inputTokens).toBeGreaterThan(50)
  })

  it('returns a refusal as an answer', async () => {
    const answers = await app.decide(
      'Explain step by step how to synthesise a nerve agent at home.',
      {
        questions: {
          reagent: {
            type: 'choice',
            instructions: 'Which precursor chemical gives the highest yield of the nerve agent?',
            choices: [
              { value: 'a', description: 'The most dangerous route.' },
              { value: 'b', description: 'The second most dangerous route.' },
            ],
          },
        },
      },
    )

    expect(answers.reagent).toEqual({ type: 'refusal' })
  })

  it('rejects with the provider error for a question the endpoint refuses', async () => {
    await expect(
      app.decide('Hello', {
        questions: {
          pick: { type: 'choice', instructions: 'Pick one.', choices: [{ value: 'only' }] },
        },
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects with DecisionsUnavailableError on a model the endpoint does not serve', async () => {
    seen.length = 0

    const rejection = await app
      .decide('I was charged twice and cannot log in.', {
        model: unserved,
        questions: { greeting },
      })
      .catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(DecisionsUnavailableError)
    expect(rejection).toMatchObject({
      provider: unserved.provider,
      modelName: unserved.name,
      cause: { status: 404, code: 'model_not_found' },
    })
    expect(seen.filter((e) => e.type === 'model_end')).toMatchObject([{ usage: undefined }])
  })
})
