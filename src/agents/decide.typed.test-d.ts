/** Type-level assertions for app.decide. Compiled by `pnpm run typecheck`. */
import { expectTypeOf } from 'vitest'

import type { AdkApp } from '../api/app'
import type { Answer, InvocationContext, Question, StateSchema } from '../types'

import { adk } from '../api/app'

const app = adk()

async function answersAreKeyedAndLiteral() {
  const answers = await app.decide('Coffee, please.', {
    questions: {
      urgent: { type: 'predicate', instructions: 'Is this an emergency?' },
      drink: {
        type: 'choice',
        instructions: 'Which drink?',
        choices: [{ value: 'tea', description: 'A hot leaf drink.' }, { value: 'coffee' }],
      },
      severity: {
        type: 'score',
        instructions: 'How severe?',
        levels: [{ label: 'Low' }, { label: 'High' }],
      },
    },
  })

  expectTypeOf<keyof typeof answers>().toEqualTypeOf<'urgent' | 'drink' | 'severity'>()
  // @ts-expect-error -- only the questions asked have answers
  void answers.missing

  const { urgent, drink, severity } = answers

  // @ts-expect-error -- an answer can be a refusal, so it has no probability until narrowed
  void urgent.probability
  expectTypeOf(urgent.type).toEqualTypeOf<'predicate' | 'refusal'>()
  if (urgent.type === 'predicate') expectTypeOf(urgent.probability).toEqualTypeOf<number>()

  expectTypeOf(drink.type).toEqualTypeOf<'choice' | 'refusal'>()
  if (drink.type === 'choice') {
    expectTypeOf(drink.choice).toEqualTypeOf<'tea' | 'coffee'>()
    expectTypeOf(drink.confidence).toEqualTypeOf<number>()
    expectTypeOf(drink.probabilities).toEqualTypeOf<
      readonly { value: 'tea' | 'coffee'; probability: number }[]
    >()
  }

  expectTypeOf(severity.type).toEqualTypeOf<'score' | 'refusal'>()
  if (severity.type === 'score') {
    expectTypeOf(severity.score).toEqualTypeOf<number>()
    expectTypeOf(severity.confidence).toEqualTypeOf<number>()
  }
}
void answersAreKeyedAndLiteral

async function questionsBuiltAtRuntimeKeepTheirNames(question: Question) {
  const answers = await app.decide('…', { questions: { option: question } })

  expectTypeOf(answers.option.type).toEqualTypeOf<Answer['type']>()
  if (answers.option.type === 'choice') expectTypeOf(answers.option.choice).toEqualTypeOf<string>()
}
void questionsBuiltAtRuntimeKeepTheirNames

// @ts-expect-error -- questions are required
void app.decide('Hello', {})
// @ts-expect-error -- a question needs a known type
void app.decide('Hello', { questions: { q: { type: 'ranking', instructions: 'Rank these.' } } })
// @ts-expect-error -- a choice needs its choices
void app.decide('Hello', { questions: { q: { type: 'choice', instructions: 'Pick one.' } } })
void app.decide('Hello', {
  // @ts-expect-error -- a decisions endpoint has no system role
  system: 'You are a router.',
  questions: { q: { type: 'predicate', instructions: 'Is this a greeting?' } },
})
void app.decide('Hello', {
  // @ts-expect-error -- like app.ask, there is no timeout option: pass a signal
  timeoutMs: 100,
  questions: { q: { type: 'predicate', instructions: 'Is this a greeting?' } },
})

// Like app.ask, decide is on the app only.
declare const typedApp: AdkApp<StateSchema>
expectTypeOf(typedApp.decide).toBeFunction()
declare const ctx: InvocationContext
// @ts-expect-error -- the invocation context has no decide
void ctx.decide
