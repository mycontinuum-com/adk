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
- `afterModel`: return modified model result or runnable to transfer.
- `beforeTool`: return tool result to skip execution.
- `afterTool`: return modified tool result.

Observation hooks:

- `onEvent(event)`
- `onStep(events, session, runnable)`

Turn hook:

- `afterTurn(ctx)` runs only through `handler.turn` and handlers that delegate to it. It runs inside the commit boundary, so state mutations are committed atomically with the turn.

Built-ins:

- `app.hook.logging(options?)`
- `app.hook.metrics(options)`
- `app.hook.cli(options?)`
- `app.hook.voice(partialVoiceHook)`
- `app.hook.voiceLogging(options?)`

Composition order: app hooks outer, agent hooks middle, call-site hooks inner. Before hooks run outer-to-inner and first non-undefined wins. After hooks run inner-to-outer.

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

Custom metrics implement `{ name, evaluate(run) }` and return `{ passed, score?, evidence? }`.

## Reports

`app.evaluate.report(options?)` returns a reusable `(result) => markdown` function. The default report includes summary, metric tables, and failure details. Options include `title`, `footer`, `sections`, and `renderCase`.

Keep eval reports git-checkable and deterministic where possible. See `batch-eval-packages.md` §Metrics And Reports for the two-layer report doctrine (ADK suite report vs domain report) and the do-not-rerun-cases-to-report rule.

Use `evalConversationLogger({ level })` when debugging simulated eval conversations instead of adding ad hoc logging to case execution.

## Voice Evals

`app.evaluate.voice(cases, options)` runs voice agents in LiveKit rooms with simulated callers. It collects transcripts, timings, recordings, events, session, usage, and duration.

Voice case fields: `name`, `agent`, `userAgent`, `toolMocks`, `metrics`, `retries`, and `timeout`.

Voice suite options: `room`, `output`, `metrics`, `hooks`, `concurrency`, `repeat`, `stopOnFirstFailure`, and `onCase`.

Use `voiceTimingMetric()` for `time_to_first_speech`, response latency p50/p95/max, silence gap max/total, and interruption count.
