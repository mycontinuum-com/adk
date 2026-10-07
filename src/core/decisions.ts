import type {
  Answer,
  Answers,
  ChoiceAnswer,
  DecisionRequest,
  Question,
  Questions,
} from '../types/decisions'
import type { ModelUsage, StreamEvent } from '../types/events'
import type {
  ModelAdapter,
  ModelConfig,
  ModelStepResult,
  ProviderModelConfig,
  RenderContext,
} from '../types/runnables'

function isProbability(value: number): boolean {
  return value >= 0 && value <= 1
}

function choiceProblem(offered: readonly string[], answer: ChoiceAnswer): string | undefined {
  if (!offered.includes(answer.choice)) return 'chooses a value the question does not offer'
  if (!isProbability(answer.confidence)) return 'has a confidence outside 0 to 1'
  const given = new Set(answer.probabilities.map((p) => p.value))
  const onePerValue =
    answer.probabilities.length === offered.length && offered.every((value) => given.has(value))
  if (!onePerValue) return 'does not give exactly one probability for each value offered'
  if (!answer.probabilities.every((p) => isProbability(p.probability))) {
    return 'has a probability outside 0 to 1'
  }
  return undefined
}

function answerProblem(question: Question, answer: Answer): string | undefined {
  if (answer.type === 'refusal') return undefined
  if (answer.type === 'predicate' && question.type === 'predicate') {
    return isProbability(answer.probability) ? undefined : 'has a probability outside 0 to 1'
  }
  if (answer.type === 'choice' && question.type === 'choice') {
    return choiceProblem(
      question.choices.map((c) => c.value),
      answer,
    )
  }
  if (answer.type === 'score' && question.type === 'score') {
    if (!(answer.score >= 0 && answer.score <= question.levels.length - 1)) {
      return 'has a score outside the levels'
    }
    return isProbability(answer.confidence) ? undefined : 'has a confidence outside 0 to 1'
  }
  return `is a ${answer.type}, but the question is a ${question.type}`
}

/**
 * Checks that `answers` answers exactly the questions asked, so that it has the type the questions
 * give it. Each question has one answer, which is a refusal or matches the question: a probability
 * from 0 to 1 for a predicate; for a choice, one of the offered values, with exactly one
 * probability for each; for a score, a position from 0 to the last level.
 *
 * @throws When an answer is missing, was not asked for, or does not match its question.
 */
export function assertAnswersMatch<Qs extends Questions>(
  questions: Qs,
  answers: Readonly<Record<string, Answer>>,
): asserts answers is Answers<Qs> {
  const unasked = Object.keys(answers).find((name) => !Object.hasOwn(questions, name))
  if (unasked !== undefined) {
    throw new Error(`Decision has an answer to '${unasked}', which was not asked`)
  }
  for (const [name, question] of Object.entries(questions)) {
    if (!Object.hasOwn(answers, name)) throw new Error(`Decision has no answer to '${name}'`)
    const problem = answerProblem(question, answers[name])
    if (problem) throw new Error(`Decision answer to '${name}' ${problem}`)
  }
}

/** Answers a decision request, with the answers checked against its questions. */
type Decide = <Qs extends Questions>(
  request: DecisionRequest<Qs>,
  model: ModelConfig,
  signal?: AbortSignal,
) => Promise<{ answers: Answers<Qs>; usage?: ModelUsage }>

/**
 * Presents one decision as the model step of an agent, so that a run records it as a model call:
 * its usage and duration on `model_end`, its failure as a failed step. After the run, `answers`
 * holds the answers, or `failure` the error the decision rejected with.
 */
export class DecisionStep<Qs extends Questions> implements ModelAdapter {
  /** The checked answers, once the step has run and the decision answered. */
  answers: Answers<Qs> | undefined
  /** The original error. A run rejects with a copy that keeps only its name and message. */
  failure: unknown

  constructor(
    private readonly runner: { decide: Decide },
    private readonly request: DecisionRequest<Qs>,
    private readonly model: ModelConfig,
  ) {}

  /** Makes the decision as this step. It emits no events and ends the agent's turn. */
  async *step(
    _ctx: RenderContext,
    _config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    try {
      const { answers, usage } = await this.runner.decide(this.request, this.model, signal)
      this.answers = answers
      return { stepEvents: [], toolCalls: [], terminal: true, usage }
    } catch (error) {
      this.failure = error
      throw error
    }
  }
}
