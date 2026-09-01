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

`adk(config)` accepts `name`, `schema`, `store`, `hooks`, and `errorHandlers`. The app exposes `schema`, `sessions`, `context`, `tools`, `mcp`, `hook`, `handler`, `agent`, `step`, `sequence`, `parallel`, `loop`, `tool`, `run`, `test`, `simulate`, `evaluate`, `cli`, and `close`.

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

## Patterns

`gated(runnable, check)` runs a precondition first. `cached(runnable, { key, scope, ttlMs })` skips a runnable when cached state exists.
