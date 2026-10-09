# Hooks, Errors, Testing, And Evals

Use this reference for lifecycle hooks, error handlers, `app.test`, `runTest`, mocks, evals, reports, and voice evals.

## Hooks

Hooks register at three levels: app, agent, and call-site.

```typescript
const app = adk({ schema })

const agent = app.agent({
  name: 'guarded',
  model,
  context,
  hooks: [
    app.hook({
      name: 'guardrail',
      beforeAgent: (ctx) => {
        if (ctx.state.blocked) return 'Blocked'
      },
      beforeTool: (ctx, call) => {
        if (call.name === 'dangerous') return { error: 'Blocked' }
      },
    }),
  ],
})

await app.run(agent, {
  input: 'Hello',
  hooks: [app.hook.metrics({ onComplete: (durationMs) => console.log('duration', durationMs) })],
})
```

Interception hooks:

- `beforeAgent`: return string to short-circuit or runnable to transfer.
- `afterAgent`: return modified output.
- `beforeModel`: return `{ stepEvents, terminal }` to skip model or runnable to transfer.
- `duringModel`: resolve with `{ stepEvents, terminal }` while the model call runs to cancel it and use that step. Its third argument is an abort signal for the hook's own work.
- `afterModel`: return modified model result or runnable to transfer.
- `beforeTool`: return tool result to skip execution.
- `afterTool`: return modified tool result.

A hook can answer an easy step itself and leave the rest to the model. Which hook to use depends on whether the answer has to be waited for:

- `beforeModel` runs first, and the model call waits for it. Use it when the hook can tell at once, from state or the transcript. A step it returns means no model call is made.
- `duringModel` runs while the model call is already in flight. Use it when the answer takes time, such as a call to [`app.decide`](runnables.md#one-shot-calls). A step the hook declines then starts no later than it would with no hook, where a `beforeModel` hook would delay it by the time the decision took.

Ask a fast closed question with `app.decide` and return a tool call only when the answer is confident:

```typescript
duringModel: async (ctx, renderCtx, signal) => {
  const answers = await app
    .decide(transcriptOf(renderCtx), { model: openai('gpt-6-luna'), signal, questions: { option } })
    .catch((error: unknown) => {
      if (error instanceof DecisionsUnavailableError) console.error(error) // a wrong model is a bug to fix
      return undefined // any failure leaves the step to the model
    })
  const answer = answers?.option
  if (answer) ctx.note('decision', { kind: 'mark', label: 'decision', data: { answers } })
  if (answer?.type !== 'choice' || answer.confidence < 0.9) return
  const call: ToolCallEvent = {
    id: createEventId(),
    type: 'tool_call',
    createdAt: Date.now(),
    invocationId: ctx.invocationId,
    agentName: renderCtx.agentName,
    callId: createCallId(),
    name: 'submit_answer',
    args: { optionId: answer.choice },
  }
  return { stepEvents: [call], toolCalls: [call], terminal: false }
}
```

`app.decide` runs no agent, so a hook that calls it is never entered again by the call. `app.ask` does run an ephemeral agent, and an app-level hook runs for that agent's model step too, so an app-level `beforeModel` or `duringModel` that calls `app.ask` calls itself. Put that hook on the agent. The `ctx.note` line records the decision in the run's session, which the call does not do by itself (`runnables.md` §One-Shot Calls).

What `duringModel` does with the hook's answer:

- **A step, before the model's step is complete.** The model call's abort signal fires and the hook's step is used as a `beforeModel` step is: `model_start`, `model_end`, then the step's events, with no count against `maxSteps`. The cancelled call is not an error, so no error handler or retry runs. How soon the provider request stops is the adapter's doing, as it is when a caller aborts.
- **Nothing, a rejection, or no answer by the time the model's step is complete.** The model's step is used. A hook that has not answered by then has its `signal` aborted. A rejection is swallowed. No error handler sees it and nothing is logged, so the hook reports for itself any failure that must be seen, as the example does. Under `beforeModel` the same throw would propagate and fail the run.

The model's streamed events are held until the hook settles or the model's step completes, whichever comes first, then released in order. A cancelled call therefore leaves nothing in the stream or in `onEvent`, and the first delta arrives no sooner than the hook's answer unless the model's whole step is done before it.

Limits:

- Only the step's first model attempt is raced. A model error while the hook is still working goes to the error handlers as usual, the events held from that attempt are dropped, and a retry runs without the hook.
- The hook's `signal` aborts once its answer can no longer be used: the model's step completed or failed first, or the caller aborted. It does not abort when the hook answers or declines in time. Pass it to whatever the hook waits on, as the example passes it to `app.decide`, so a hook that has lost stops there. `ctx.signal` is the run's signal and does not tell the hook this. A hook that ignores `signal` runs on. Its answer is ignored, but what it does on the way still happens, late, and the next step asks it again while that call is in flight.
- `duringModel` cannot transfer. Return a runnable from `beforeModel` or `afterModel` for that.
- The provider may bill the cancelled call, and the ADK never learns its usage. The step's `model_end` has no usage, so the run's cost reads `unavailable`, not free.

Observation hooks:

- `onEvent(event)`
- `onStep(events, session, runnable)`

Turn hook:

- `afterTurn(ctx)` runs only through `handler.turn` and handlers that delegate to it. It runs inside the commit boundary, so state mutations are committed atomically with the turn.

Built-ins:

- `app.hook.logging(options?)`
- `app.hook.metrics(options)`
- `app.hook.console(options?)`
- `app.hook.voice(partialVoiceHook)`
- `app.hook.voiceLogging(options?)`

Composition order: app hooks outer, agent hooks middle, call-site hooks inner. Before hooks run outer-to-inner and first non-undefined wins. After hooks run inner-to-outer. `duringModel` hooks compose as before hooks do: they are asked one at a time, outer-to-inner, each once the one before has declined, and the first step wins. Within a step they do not run beside each other, only beside the model call.

An agent created by `app.agent` without `hooks` takes the app's hooks as its agent hooks, and the run adds the app's hooks again. For that agent every app-level hook runs twice: `onEvent` receives each event twice, and a `beforeModel` or `duringModel` that returns nothing runs twice per step. An agent given its own `hooks` runs each app-level hook once.

## Error Handlers

Use error handlers for recovery policies:

```typescript
import {
  retryHandler,
  rateLimitHandler,
  timeoutHandler,
  loggingHandler,
  defaultHandler,
  PipelineStructureChangedError,
  OutputParseError,
  ConflictError,
} from '@animahealth/adk'
```

Actions are `throw`, `skip`, `abort`, `retry`, `fallback`, and `pass`.

Custom handlers implement `canHandle(ctx)` and `handle(ctx)`.

Common option names: `retryHandler({ maxAttempts, baseDelay, maxDelay, backoffMultiplier, retryable })`, `rateLimitHandler({ maxRetries, baseDelay })`, and `timeoutHandler({ fallbackResult })`.

## app.test, app.simulate, app.evaluate

`app.test(runnable, options)` gives deterministic yield/resume automation through handlers for tool yields and user messages.

`app.simulate(runnable, options)` runs LLM-powered user/tool simulation.

`app.evaluate(cases, options)` composes simulation with tool interception, metrics, retries, concurrency, and report generation. See `batch-eval-packages.md` §Canonical Shape for the default-runner doctrine (what belongs in custom CLI code vs the ADK eval surface).

Use the builder helpers to preserve types at case boundaries: `app.evaluate.case(...)`, `app.evaluate.cases(...)`, `app.evaluate.metric(...)`, `app.evaluate.report(...)`, and the voice equivalents under `app.evaluate.voice`.

`app.evaluate` and `app.evaluate.cases` also accept a mixed array of text and voice cases.
Use one `concurrency` and `repeat` for the suite; put voice-specific room configuration, hooks
and metrics in `options.voice`. Common metrics can inspect the session for either kind.

`process.exitCode = await app.evaluate.cli(cases, options)` exposes those same cases through
`list` and `run`, with `--case <exact-name>` (repeatable), `--kind text|voice`, `--repeat <n>`,
`--output <directory>`, `--baseline <run>` (repeatable) to compare with earlier runs, and
`--record` to replace the suite's scorecard. `--record` needs the scorecard's `fingerprint` paths
committed, and it leaves that file untouched when a run stopped early, or when a case ended
`error`, `timeout` or `aborted`. A suite that sets `options.scorecard` to `{ path, fingerprint }`
compares each run with that committed file when no `--baseline` is given.
Keep `path` in the repository of the `fingerprint` paths, and outside them.
It returns JSON and saves reports plus per-case evidence in a fresh run directory. Exit codes
are 0 for complete success, 1 for failed/incomplete evaluation and 2 for invocation/export errors.
Use silent package scripts for machine output, for example `pnpm --silent run eval:greeting list`.
Keep entry-module initialization quiet. No suite registration or evaluator injection is needed.

### Verification skill integration

The ADK supplies `app.evaluate.cli`; it does not create an executable or add package scripts.
Reuse the product's eval entry file, or add a small one that calls the CLI with its cases:

```typescript
async function main() {
  process.exitCode = await app.evaluate.cli(cases, options)
}
void main()
```

The product owns the command name. For example, with `"eval": "node --import tsx evals/index.ts"`
in its `package.json`, run `pnpm --silent run eval list` or
`pnpm --silent run eval run --case greeting/english`. Use the target's existing TypeScript
runner or compiled JavaScript setup; the script name and file path above are examples, not
commands that installing ADK creates. Scripts are package-local; case names are local to the
supplied suite and should be qualified when composing case arrays.

A product verification skill should record the working directory, exact commands, required
environment, feature-to-case/metric mapping, and where to read the result and detailed evidence.
State which tools or transports are mocked and what remains unverified. A passing text case
does not prove voice transport, and aggregated independent cases do not prove agent handoffs.
Keep UI, API and deployed integration checks where the feature needs them. Link to this shared
ADK guidance for the API mechanics rather than copying a runner into each verification skill.

## runTest API

Use `@animahealth/adk/testing` for explicit step-based tests:

```typescript
import { runTest, user, model, input, result, setupAdkMatchers } from '@animahealth/adk/testing'

setupAdkMatchers()

const { session, status } = await runTest(agent, [
  user('Calculate 2 + 2'),
  model({ toolCalls: [{ name: 'calculate', args: { expr: '2+2' } }] }),
  result({ calculate: { answer: 4 } }),
  model({ text: 'The answer is 4' }),
])
```

`runTest` options include `initialState`, `schema`, `sessionId`, `scopes`, and `timeout`.

Steps:

- `user(text)`: add a user event.
- `model(response)`: queue mock model response and run an agent iteration.
- `input({ toolName: value })`: provide input for yielding tools.
- `result({ toolName: value })`: mock tool result and skip execute.

Matchers include:

- `toHaveAssistantText`
- `toHaveToolCall`
- `toHaveToolResult`
- `toHaveState`
- `toHaveEvent`
- `toHaveEventSequence`
- `toHaveStatus`
- `toBeUuid`

Use `MockAdapter`, `testAgent`, `createTestSession`, and `collectStream` for lower-level testing utilities.

`new MockAdapter({ decisions })` scripts `app.decide`: `decisions` maps each question name to the answer it gets, and a question with no entry fails the call. `app.decide` checks every adapter's answers against the questions, the mock's included, so a scripted answer must suit its question: a choice among the offered values with a probability for each, a score within the levels. `adapter.decideCalls` records each request. Pass the adapter to the app, `adk({ adapters })`: `app.ask` and `app.decide` use the app's adapters, not the one `runTest` builds.

```typescript
const adapter = new MockAdapter({
  decisions: { urgent: { type: 'predicate', probability: 0.97 } },
})
const app = adk({ adapters: { openai: adapter }, defaultModel: openai('gpt-6-luna') })
```

## Tool Mocks In Evals

Unmocked tools error by default in evals. Mock output tools too, or pass through the real output tool.

```typescript
toolMocks: {
  searchPatients: {
    execute: (args, ctx) => ({ results: [] }),
  },
  end_call: endCallTool,
}
```

Use `withStateChange(result, stateChanges)` when a mock should update state alongside a result.

Use `app.tools.mock(...)` and `app.tools.mocks(...)` when eval packages need app-bound type checking for `ToolMock` and `ToolMocks` (see `batch-eval-packages.md` §Case Design for the toolMocks/toolAgents distinction).

Advanced eval exports from `@animahealth/adk/eval` include `interceptTools`, `evalConversationLogger`, `EvalToolError`, `withStateChange`, and state-change helpers.

## Eval Cases

Eval cases require `name` and `runnable`. Common fields:

- `input`: string or `{ message, state }`.
- `toolMocks`: mocked tools.
- `userAgent`: simulated user.
- `toolAgents`: simulated tool-yield responders.
- `maxTurns`, `maxDuration`, `timeout`.
- `stateMatches`: early termination condition.
- `metrics`: per-case metrics.
- `transform`: transform simulated user output.
- `retries`: extra attempts.

Suite options include `metrics`, `hooks`, `concurrency`, `stopOnFirstFailure`, `repeat`, and `onCase`.

Build cases at the sample boundary: one eval case should represent one independently reviewable input/candidate. Put deterministic fixture hydration and cache reuse before case creation, and put hard gates in metrics or report post-processing.

## Metrics

Metric factories from `@animahealth/adk/eval`:

- `stateMetric`
- `eventCountMetric`
- `eventSequenceMetric`
- `timingMetric`

Timing measures include total duration, time to first assistant, time to first tool call, model latency total/average, and tool execution total/average.

`app.evaluate.judge({ name, criteria })` is an LLM-judge metric for speech that has no structural signal. See `docs/judge-metric.md` in the ADK package for when to use it instead of a state or event metric.

Custom metrics implement `{ name, evaluate(run) }` and return `{ passed, score?, evidence? }`. A metric that throws makes its case `error`, not `failed`. So return `passed: false` for a product failure, including a missing state value, and throw only when no verdict is possible.

## Reports

`app.evaluate.report(options?)` returns a reusable `(result) => markdown` function. The default report includes summary, metric tables, and failure details. Options include `title`, `footer`, `sections`, and `renderCase`.

Keep eval reports git-checkable and deterministic where possible. See `batch-eval-packages.md` §Metrics And Reports for the two-layer report doctrine (ADK suite report vs domain report) and the do-not-rerun-cases-to-report rule.

Use `evalConversationLogger({ level })` when debugging simulated eval conversations instead of adding ad hoc logging to case execution.

## Voice Evals

`app.evaluate.voice(cases, options)` runs voice agents in LiveKit rooms with simulated callers. It collects transcripts, timings, recordings, events, session, usage, and duration.

Voice case fields: `name`, `agent`, `userAgent`, `toolMocks`, `metrics`, `retries`, and `timeout`.

`userAgent` is the simulated caller and uses a Realtime model. When the agent under test is a GPT Live handler, the caller can use `openai.live('gpt-live-1')` instead. See `docs/gpt-live.md`.

Voice suite options: `room`, `output`, `metrics`, `hooks`, `concurrency`, `repeat`, `stopOnFirstFailure`, and `onCase`.

Use `voiceTimingMetric()` for `time_to_first_speech`, response latency p50/p95/max, silence gap max/total, and interruption count.
