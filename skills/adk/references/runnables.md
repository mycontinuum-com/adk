# Runnables

Use this reference for `adk()`, app factories, tools, runnable composition, orchestration, multimodal input, `app.run`, streaming, and structured output.

## App And Schema First

Prefer this spine for application code. Define app and state before agents so every later surface is app-bound and typed:

```typescript
import { z } from 'zod'
import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk({
  name: 'my-app',
  schema: {
    session: {
      answer: z.string(),
    },
  },
})

const tool = app.tool({
  name: 'lookup',
  description: 'Look up a record',
  schema: z.object({ id: z.string() }),
  execute: async (ctx) => ({ id: ctx.args.id }),
})

const agent = app.agent({
  name: 'assistant',
  model: openai('gpt-5-mini'),
  context: [app.context.system('Be concise.'), app.context.history()],
  tools: [tool],
  output: 'answer',
})

const result = await app.run(agent, 'Hello')
```

`adk(config)` accepts `name`, `schema`, `store`, `hooks`, and `errorHandlers`. The app exposes `schema`, `sessions`, `context`, `tools`, `mcp`, `hook`, `handler`, `agent`, `step`, `sequence`, `parallel`, `loop`, `tool`, `run`, `test`, `simulate`, `evaluate`, `terminal`, and `close`.

Advanced helpers include `app.use(spec)`, `app.toolInputsSchema()`, `app.message()`, `app.enrichment()`, and `app.initialState()`. Use `spec.*` only for reusable factories shared across apps. Do not start a package with specs when all code belongs to one app/schema.

## Agents

An agent is the LLM-powered runnable:

```typescript
app.agent({
  name: 'assistant',
  description: 'Used by orchestrators',
  model,
  context: [app.context.system('...'), app.context.history()],
  tools: [toolOrMcpServer],
  output,
  toolChoice: 'auto',
  maxSteps: 25,
  hooks: [],
  errorHandlers: [],
  yields: false,
  maxTurns: 100,
  timeouts: { inactivity: 30_000, expiry: 300_000 },
})
```

`output` may be a session schema key, an explicit output config, or a `FunctionTool` when completion should validate input, execute a final side effect, and capture the output. If a session key points at an object/array schema, ADK uses native structured output. Primitive keys use raw output casting.

Realtime models default `yields` to true. Text agents generally complete unless `yields` is set.

Prefer agent-level `output` schemas over prompting for JSON. If output must be repaired after the fact, use parser/coercion utilities from the main entry rather than hand-written string parsing.

## Context And Tools

Agents only see what their `context` array renders and can only call tools listed in `tools`. Agent `tools` may contain ADK function tools, MCP servers, or provider-native tools such as OpenAI `{ type: 'web_search' }`.

```typescript
const agent = app.agent({
  name: 'operator',
  model,
  context: [
    app.context.system('Follow the current task contract.'),
    app.context.user((ctx) => `Current case: ${ctx.state.caseId}`),
    app.context.history({ scope: 'invocation' }),
  ],
  tools: [lookupTool, submitTool],
  output: 'result',
})
```

Use app-bound tools for external effects, state updates, human/tool yields, and app-specific contracts. Use deterministic steps for local transformations and routing.

## Steps

Use steps for deterministic TypeScript logic, side effects, gates, routing, and state updates.

```typescript
const route = app.step({
  name: 'route',
  execute: (ctx) => {
    if (!ctx.state.authorized) ctx.fail('Not authorized')
    if (ctx.state.cached) return ctx.respond(ctx.state.cached)
    if (ctx.state.priority === 'urgent') return urgentAgent
  },
})
```

Step signals throw internally; call `ctx.skip()`, `ctx.respond(text)`, or `ctx.fail(message)` directly. Returning a runnable delegates execution to that runnable.

`StepContext` includes `invocationId`, `session`, `state`, `output(value)`, and orchestration methods `run`, `spawn`, and `dispatch`.

## Composition

`app.sequence({ name, runnables })` runs children in order through the same session.

`app.parallel({ name, runnables, failFast, branchTimeout, minSuccessful, merge })` runs cloned branches concurrently and merges events deterministically. Shared scopes (`user`, `patient`, `practice`, `org`, `team`) are passed by reference; avoid concurrent writes to the same shared keys.

`app.loop({ name, runnable, maxIterations, while, yields })` repeats a runnable while the condition returns true. Use `yields: true` for chat-style loops that pause for user input between iterations.

## Tools

Tools are Zod-typed and receive state/session/orchestration context:

```typescript
const ask = app.tool({
  name: 'ask',
  description: 'Ask for external input',
  schema: z.object({ question: z.string() }),
  yieldSchema: z.object({ answer: z.string() }),
  finalize: (ctx) => ({ question: ctx.args.question, answer: ctx.input!.answer }),
})
```

Tool options are `name`, `description`, `schema`, `yieldSchema`, `prepare`, `execute`, `finalize`, `timeout`, `retry`, and `requiresApproval`. A tool must have either `execute` or `yieldSchema`. Use `yieldSchema` for human-in-the-loop input; `requiresApproval` is metadata used by executor/workspace tools and should not replace an explicit yield contract.

A model step's tool calls run in order. When one ends the run, through `ctx.output(value)`, an
agent transfer or an aborting tool error, the calls after it in that step do not run: each gets a
`tool_result` whose `error` is `Not run: <tool> ended the turn first.`, so the next request to the
model never holds a call without a result. A delegate that yields still leaves the calls after it
without a result.

`app.replyTool({ name?, description, schema })` makes a tool whose call is the agent's reply: it
calls `ctx.output(args)`, so the turn ends with the value a text reply parsed against the same
schema gives. Pass the agent's output schema. It lets a step require a tool without forcing an
exit: with `toolChoice: 'required'` and the reply tool among the offered tools, text cannot end the
step, and replying is still possible. It does not write the agent's `output.key`, and the history
holds a tool call and result instead of an assistant message.

```typescript
const reply = z.object({ message: z.string() })
const replyTool = app.replyTool({ description: 'Say this to the caller.', schema: reply })
// In a step where only a tool may answer:
// app.context.toolChoice('required'), with replyTool and end_call offered
```

Yielding tool lifecycle:

1. `prepare` transforms args and stores the prepared args in the yield event.
2. Execution yields for `session.input.tool({ callId, input })`.
3. `execute` runs with `ctx.input` if provided.
4. `finalize` may post-process `ctx.args`, `ctx.input`, and `ctx.result`.

## Orchestration

`ToolContext` and `StepContext` support:

- `ctx.run(runnable, input)`: await sub-agent result.
- `ctx.spawn(runnable, input)`: background task with `wait()` and `abort()`.
- `ctx.dispatch(runnable, input)`: fire-and-forget.
- return a runnable from a tool/step/hook to transfer control.

Set state before transfer when the target needs handoff context.

It is valid for deterministic tools and steps to orchestrate sub-agents with `ctx.run(...)`, then write the result into state or artifacts. Keep the orchestration boundary visible in events instead of calling model providers directly inside the tool.

## Multimodal Input

Pass images and other media through ADK message input so provider adapters, sessions, traces, and evals all see the same event shape.

```typescript
await app.run(visionAgent, {
  input: {
    message: {
      text: 'Transcribe this page.',
      media: [
        {
          type: 'image',
          source: {
            type: 'base64',
            data: imageBase64,
            mimeType: 'image/png',
          },
        },
      ],
    },
  },
})
```

For document workflows, prefer one user message containing the current page image and concise text instructions. Include previous-page images only when the model contract needs visual continuity; otherwise use compact state/context hints.

Local reference: [examples/vision.ts](../../../examples/vision.ts).

## Reusable Specs

Use `spec.*` only for reusable factories shared across apps/schemas. Application code should usually use `app.*`.

```typescript
import { spec } from '@animahealth/adk'

const reusable = spec.tool({ session: { count: z.number() } })({
  name: 'increment',
  description: 'Increment count',
  schema: z.object({ amount: z.number() }),
  execute: (ctx) => {
    ctx.state.count += ctx.args.amount
    return ctx.state.count
  },
})

const bound = app.use(reusable)
```

## Running

`app.run(runnable, input)` accepts a string or `{ session, input, hooks, errorHandlers, timeout }`. `input` can include `message`, `tools`, `state`, and `initialState`.

`app.run()` returns a `StreamResult`: await it for `RunResult`, iterate it for stream events, or call `abort()`.

Run statuses include `completed`, `yielded_tool`, `yielded_message`, `error`, `skipped`, `aborted`, `max_steps`, `max_turns`, `max_duration`, `inactivity_timeout`, `disconnected`, `participant_left`, `terminated`, and `transferred`.

Output is available as `result.output.text`, `result.output.value`, `result.output.items`, and `result.output.media`.

## One-Shot Calls

`app.ask(prompt, opts?)` and `app.decide(input, opts)` each make one isolated call outside any run. They take no tools and no session, and a hook, tool or step calls them through the app. Both use `opts.model`, then the app's `defaultModel`, and throw when neither is set. Both take `opts.signal`.

`app.ask` returns the assistant text, or a typed value when `opts.schema` is set. `opts.system` adds a system prompt. A reply that fails the schema is asked again up to `opts.retries` times (2 by default).

`app.decide` answers closed questions about an input on the model's decisions endpoint, in tens of milliseconds where a model call takes most of a second. Questions are keyed by name in `opts.questions`, and it returns the answers under the same names:

```typescript
const { emergency, drink, severity } = await app.decide(transcript, {
  model: openai('gpt-6-luna'),
  questions: {
    emergency: { type: 'predicate', instructions: 'Does the caller describe an emergency?' },
    drink: {
      type: 'choice',
      instructions: 'Which drink did the caller choose?',
      choices: [{ value: 'tea' }, { value: 'coffee' }, { value: 'none', description: 'No choice.' }],
    },
    severity: {
      type: 'score',
      instructions: 'How severe is the problem?',
      levels: [{ label: 'Minor' }, { label: 'Serious' }, { label: 'Critical' }],
    },
  },
})

if (emergency.type === 'predicate' && emergency.probability >= 0.9) adviseEmergencyServices()
if (drink.type === 'choice' && drink.confidence >= 0.9) order(drink.choice) // 'tea' | 'coffee' | 'none'
```

- A predicate's answer has a `probability`. A choice's has its `choice`, a `confidence` and a probability for each value. A score's has a `score`, the probability-weighted position on the levels from 0, and a `confidence`. Set thresholds from labelled examples of your own.
- Any answer can be `{ type: 'refusal' }`, so narrow on `type` first.
- Only a model its provider serves on a decisions endpoint can answer. Today that is OpenAI `gpt-6-luna`, through `POST /decisions`. Any other model, and a provider with no such endpoint, rejects with `DecisionsUnavailableError`, which names the model. There is no fallback to a model call, because a model call returns no probabilities.
- There is no system prompt. Put shared context in the input and guidance in each question's `instructions`. Model settings the endpoint has no use for, such as reasoning effort, are ignored.
- The questions share one request, so none can depend on another's answer. Ask a dependent question in a second call.
- A provider error, an aborted signal and answers that do not match the questions reject. Every adapter's answers are checked: each question has one answer, a refusal or of its own type; a choice is one of the offered values with exactly one probability for each; a score lies on the levels. Catch the rejection where a slower path can take over.
- Like `app.ask`, the call joins no run. Nothing is written to the session of a run that makes it, and that run's `usage` does not count it. The app's hooks see it as one `model_start` and one `model_end` under the agent name `decide`. The `model_end` carries the usage and duration, or the error and no usage.
- Unlike `app.ask`, no agent runs. Of the app's hooks only `onEvent` sees the call. No `before` or `after` hook and no `onStep` runs for it, and the app's error handlers do not apply, so a failed call rejects once and the caller decides whether to try again.

To record a decision in a run, note it from the hook, step or tool that made it:

```typescript
ctx.note('decision', { kind: 'mark', label: 'decision', data: { answers } })
```

The annotation is in `session.events` for evals and later code. No model sees it, because history does not render annotations. An agent that should read it needs a context renderer:

```typescript
const decisionsSoFar: ContextRenderer = (ctx) => {
  const marks = ctx.session.events.filter(isAnnotationEvent).filter((e) => e.label === 'decision')
  return app.context.system(`Decisions so far: ${JSON.stringify(marks.map((m) => m.data))}`)(ctx)
}

const agent = app.agent({ name: 'barista', model, context: [decisionsSoFar, app.context.history()] })
```

## Patterns

`gated(runnable, check)` runs a precondition first. `cached(runnable, { key, scope, ttlMs })` skips a runnable when cached state exists.

## Composing independently runnable packages

Use `parent.bind({ app: child, runnable })` to put a separately constructed stage into a parent
sequence. Declare the child's session fields in the parent schema. The parent schema must extend
the child's schema; incompatible field types are rejected by TypeScript.

Bound components take their input from session state and must run to completion. Binding creates
an isolated child invocation: the parent's `input.message` is not automatically forwarded to the
child's invocation history. Construct model context from the child's declared state inputs.
Conversational or yielding components need explicit input routing outside this binding contract.

```typescript
const parent = adk({
  name: 'document',
  schema: { session: { ...transcription.app.schema.session, ...extraction.app.schema.session } },
  adapters,
})
const flow = parent.sequence({
  name: 'document-flow',
  runnables: [parent.bind(transcription), parent.bind(extraction)],
})
```

Binding runs the child through the parent's existing runner, session, model adapters and global
hooks. The child keeps its configured agent contexts, models, tools and agent hooks. Invocation
ancestry and usage stay in one event stream. Closing an independently configured child app remains
the caller's responsibility when it owns resources such as MCP connections.

The binding step validates and applies the child's session values/defaults before running it,
validates the parent state after completion, and returns the child output. Failed or interrupted
children, including yielded or partially completed runs, fail the binding without publishing an output. Binding currently supports session-only
child schemas; shared and temporary scopes are rejected. Each child should reset its own transient
state in its public runnable when repeated execution requires a fresh result.
