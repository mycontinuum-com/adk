import type { ModelUsage } from './events'
import type { ModelConfig } from './runnables'

/**
 * A closed question about an input. A choice needs at least two distinct values and a score at
 * least two distinct labels, ordered from lowest to highest.
 */
export type Question =
  | { type: 'predicate'; instructions: string }
  | {
      type: 'choice'
      instructions: string
      choices: readonly { value: string; description?: string }[]
    }
  | {
      type: 'score'
      instructions: string
      levels: readonly { label: string; description?: string }[]
    }

/** Questions keyed by name. The names key the answers. */
export type Questions = Readonly<Record<string, Question>>

/** `probability` is the model's estimate, from 0 to 1, that the condition holds. */
export interface PredicateAnswer {
  type: 'predicate'
  probability: number
}

/**
 * `choice` is the value the model picked and `confidence`, from 0 to 1, how sure it is of the pick.
 * `probabilities` has one entry for each value the question offered.
 */
export interface ChoiceAnswer<V extends string = string> {
  type: 'choice'
  choice: V
  confidence: number
  probabilities: readonly { value: V; probability: number }[]
}

/**
 * `score` is the probability-weighted position on the levels, from 0 for the first, so it can fall
 * between two levels.
 */
export interface ScoreAnswer {
  type: 'score'
  score: number
  confidence: number
}

/** The provider declined to answer this question. */
export interface RefusalAnswer {
  type: 'refusal'
}

/**
 * The answer to a question of type `Q`: a refusal, or the answer of the question's own type. A
 * choice's value is typed as the values the question offers.
 */
export type Answer<Q extends Question = Question> =
  | RefusalAnswer
  | (Q extends { type: 'predicate' }
      ? PredicateAnswer
      : Q extends { type: 'choice'; choices: readonly { value: infer V extends string }[] }
        ? ChoiceAnswer<V>
        : ScoreAnswer)

/** One answer per question, under the question's name. */
export type Answers<Qs extends Questions = Questions> = { [K in keyof Qs]: Answer<Qs[K]> }

/**
 * Options for `app.decide`. There is no `system` option, because a decisions endpoint has no system
 * role: put shared context in the input and guidance in each question's `instructions`.
 */
export interface DecideOpts<Qs extends Questions = Questions> {
  /** The questions, keyed by name. They share one request, so none can depend on another. */
  questions: Qs
  /**
   * Defaults to the app's `defaultModel`, as `app.ask` does. It must be a model its provider serves
   * on a decisions endpoint. Settings that endpoint has no use for, such as reasoning effort, are
   * ignored.
   */
  model?: ModelConfig
  /** Aborts the provider call, which then rejects with the provider's error. */
  signal?: AbortSignal
}

/** What a model adapter's decisions endpoint is asked. */
export interface DecisionRequest<Qs extends Questions = Questions> {
  input: string
  questions: Qs
}

/**
 * What a model adapter's decisions endpoint answered, by question name. The ADK checks it against
 * the questions before `app.decide` returns it.
 */
export interface DecisionResponse {
  answers: Record<string, Answer>
  usage?: ModelUsage
}
