# Context And Sessions

Use this reference for context rendering, prompt-cache-stable context, typed prompts, event ledger semantics, state scopes, stores, yield/resume, artifacts/provenance, and historical snapshots.

## Context Rendering

The session event ledger is the source of truth. Model context is a rendered projection:

```text
session.events -> context renderers -> RenderContext -> model request
```

Every agent must declare its context explicitly:

```typescript
context: [
  app.context.system('You are helpful.'),
  app.context.history(),
  app.context.pruneReasoning(),
]
```

Built-in renderers:

- `app.context.system(text | fn | app.message(...))`
- `app.context.user(text | fn | app.message(...))`
- `app.context.history(options?)`
- `app.context.transform(fn | app.enrichment(...), options?)`
- `app.context.pruneUserMessages('self' | agentName)`
- `app.context.selectRecent(count)`
- `app.context.pruneReasoning()`
- `app.context.limitTools(names)`
- `app.context.toolChoice(choice)`
- `app.context((ctx) => nextCtx)` for custom transforms.

Do not read rendered prompt text back as state. If a downstream step needs a value, keep it in `ctx.state`, a tool result, an output schema, an artifact, or an event.

## Typed Prompts

Use `app.message()` for prompts that create new system/user events and `app.enrichment()` for transforms of existing user messages.

```typescript
app.context.system(app.message((ctx) => `Current mode: ${ctx.state.mode ?? 'unknown'}`))

app.context.transform(app.enrichment((ctx) => `<request>${ctx.message}</request>`))
```

## History Scopes

`app.context.history()` defaults to direct scope. This keeps orchestration internals isolated unless you opt in.

- `direct`: root/transfer agents see cross-turn history; called/spawned/dispatched agents see their own invocation.
- `all`: every event.
- `invocation`: current invocation only.
- `ancestors`: current invocation, parent chain, and cross-turn roots.
- `agent`: lineage events for the same agent plus user messages.

## Prompt Cache

Providers cache a request by its leading tokens (the KV cache): a request reuses the cache up to its first changed token and pays full price for everything after it. Design context so each request extends the previous one.

1. Register every tool the agent will ever use once, in a fixed order, with a name, description and schema that do not vary by state. Tool definitions sit at or near the start of the request, so a change there can invalidate everything after it.
2. Turn tools on and off per turn with a context renderer that sets `allowedTools`: `app.context.limitTools(names)`, or `app.context((ctx) => ({ ...ctx, allowedTools, toolChoice }))` when the set depends on state. Add `toolChoice: 'required'` where a call is mandatory. The model keeps every definition in context and is only restricted in what it may call this turn. Never build a different `tools` array per turn. Put state-dependent guidance in the tool result or a trailing context message, not in a tool's description or schema.
3. Keep the context prefix-complete: fixed instructions first, then append-only history, then anything dynamic (state snapshots, phase guidance) last, so only the tail is re-sent uncached. Never rewrite or reorder earlier history, and never put timestamps, ids or per-turn state in the leading instructions.
4. Measure it. Each `model_end` event carries `usage.inputTokens` and `usage.cachedTokens`; cached tokens are a subset of input tokens on every provider. Cached share is the sum of `cachedTokens` over the sum of `inputTokens` (`totalCachedTokens / totalInputTokens` on a run result's `usage`). Also compare each step's `cachedTokens` with the previous step's `inputTokens`. A well-formed multi-turn agent reuses about 90% of the previous request.

```typescript
context: [
  app.context.system(FIXED_INSTRUCTIONS),
  app.context.history(),
  app.context.user(app.message((ctx) => `Current phase: ${ctx.state.phase}`)),
  app.context((ctx) => ({ ...ctx, allowedTools: toolsFor(ctx.state.phase), toolChoice: 'required' })),
]
```

What each provider does with `allowedTools`:

| Provider | Request | Tool definitions |
| --- | --- | --- |
| OpenAI Responses | `tool_choice: { type: 'allowed_tools', mode, tools }`; `mode` is `'required'` only when `toolChoice` is `'required'`, otherwise `'auto'` | Unchanged |
| Gemini | `functionCallingConfig.allowedFunctionNames`; mode `ANY` when `toolChoice` is `'required'`, otherwise `AUTO` | Unchanged |
| Claude | Exactly one allowed tool becomes `tool_choice: { type: 'tool', name }`. A longer list is ignored, and so is any list when `thinking` is set | Unchanged |
| Chat Completions, EUrouter | None; the tools outside the list are removed from `tools` | Changed, so the cache can break there |

An empty `allowedTools` list restricts nothing on any provider. On OpenAI and Gemini a `{ name }` tool choice is dropped when `allowedTools` is set; to force one tool, allow only that tool and set `'required'`. The ADK does not reject a call to a tool outside the list, so on Claude with several allowed tools the restriction must live in the tool or the instructions.

Claude and Gemini move every system message into the leading system block, wherever its renderer sits in `context`. On those providers a dynamic `app.context.system(fn)` changes the prefix; render dynamic content as a trailing user message. OpenAI Responses and Chat Completions keep system messages in place.

Under concurrency, many sessions share the same leading instructions and the provider can route them to different cache nodes, so a step can fall back to the shared instruction prefix or to nothing. The lever on OpenAI is the `promptCache` model option (`key`, `mode: 'explicit'`, `ttl: '30m'`), sent as `prompt_cache_key` and `prompt_cache_options`; see [providers](providers-memory.md#openai). It needs at least one message tagged with `app.context.cacheableUser(text)` and throws without one. The key is a static string of at most 64 characters on the model config, and an agent's `model` is fixed, so the key cannot vary per session or per call. A per-session key needs a separate model config and agent per key. Without `promptCache` the ADK sends no cache options and the provider's automatic caching applies. Vertex Claude marks system blocks with `cache_control` by default (`promptCache.enabled`, `ttl`, `system`).

Measured on 2026-10-01 on the patient-voice GPT Live backend (gpt-5.4-mini, OpenAI Responses):

- One call at a time, 309 requests: cached share 0.91. Every step reused at least 76% of the previous request, and only the trailing dynamic messages were re-sent.
- Twelve concurrent calls: cached share 0.65 to 0.71. 18% of steps fell back to the shared instruction prefix of about 7.5k tokens and 3.5% to zero. This is cache routing across calls that share a prefix, not a rewritten context.
- The 221 steps where a tool was added, removed or redefined still reused about 90%, so tool changes did not measurably break the OpenAI Responses cache. The fixed tool list remains the rule because other providers place tool definitions at the start of the cached prefix, and because `allowedTools` is designed for a fixed list.

## Sessions

Use `app.sessions`, not deprecated `app.session()`, for lifecycle:

```typescript
const session = await app.sessions.create({
  sessionId: 'thread-1',
  scopes: { user: 'user-1', patient: 'patient-1' },
})

session.input.message('Hello')
await app.run(agent, { session })
await app.sessions.commit(session, session.version)
```

Session API:

- `id`, `appName`, `version`, `scopes`, `events`, `state`, `status`, `yieldedTools`, `currentAgentName`, `createdAt`.
- `input.message(text | MessageInput)`, `input.tool({ callId, input })`, `input.tools([...])`.
- `output.text`, `output.value`, `output.items`, `output.media`.
- `boundState(invocationId)`, `clone()`, `eventIndexOf(id)`, `stateAt(index)`, `forkAt(index)`, `onStateChange(callback)` (one callback; a later call replaces it). `addStateChangeListener(listener)` adds a listener alongside it and returns a function that removes it; the listener receives the event and the session that recorded it, and a clone copies both.
- Spawned task helpers: `getSpawnedTaskStatus`, `getRunningSpawnedTasks`, `getAllSpawnedTasks`, `waitForSpawnedTask`, `waitForAllSpawnedTasks`, `hasRunningSpawnedTasks`.

`app.sessions` exposes `create`, `get`, `delete`, `list`, `commit`, and `merge`. Use `commit` for normal optimistic persistence and `merge` only when a handler-style conflict policy has deliberately accepted newer committed input.

## State Scopes

Schema lives under `adk({ schema })` and flows into `ctx.state` and `session.state`.

- `session`: current session, shorthand at `ctx.state.key`.
- `user`: shared across user sessions.
- `patient`: shared across patient encounters.
- `practice`: practice settings.
- `org`: org-level configuration.
- `team`: team-level state.
- `temp`: per-model-step scratch, not logged.

Use `ctx.state.update({...})` for bulk session updates and `ctx.state.user.update({...})` for shared scopes. Set a key to `undefined` to delete it.

State changes produce `state_change` events for audit. Shared-state observations are logged during bound execution when shared state has changed since last read. Direct `session.state` access does not trigger observations.

`input.state` applies session-scope input for the current run. Use `input.initialState` or `app.initialState(...)` when seeding typed state across session and shared scopes for tests, evals, handlers, or voice setup.

## Artifacts And Provenance

Use the event ledger for provenance and artifacts for durable binary/text outputs that should not live in session state.

- Session events show inputs, model/tool boundaries, state changes, yields, usage, and artifact updates.
- State holds compact durable facts needed by future runnables.
- Artifacts hold large or reviewer-facing outputs such as transcripts, extracted files, reports, images, recordings, and intermediate bundles.
- Filesystem exports are acceptable for local review and recovery, but canonical ADK provenance is the session/events/artifact service.


## Stores

Pass a `SessionStore` to `adk({ store })`. Current public stores:

```typescript
import { inMemoryStore } from '@animahealth/adk'
import { postgresStore } from '@animahealth/adk/stores/postgres'
import { dynamoStore } from '@animahealth/adk/stores/dynamodb'
```

- `inMemoryStore()`: default, no peer dependency, in-process atomicity.
- `postgresStore(...)`: `pg` peer dependency, transactional commits and scoped state.
- `dynamoStore(...)`: AWS SDK peer dependencies, optimistic metadata commit with scoped-state writes after the guarded metadata write.

All stores implement `SessionStore` and must satisfy the shared compliance suite. Store implementations persist metadata/events/scoped state; orchestration, scope binding, event buffering, dirty tracking, and cursor management belong in `sessionService()`.

Do not copy README SQLite session-store examples unless the export exists in `package.json`; there is no public SQLite session store subpath in the current package.

## Yield And Resume

Yielded tool:

```typescript
if (result.status === 'yielded_tool') {
  const call = result.yieldedTools[0]
  session.input.tool({ callId: call.callId, input: { approved: true } })
  await app.run(agent, { session })
}
```

Yielded message:

```typescript
if (result.status === 'yielded_message') {
  session.input.message({
    text: 'continue',
    invocationId: result.yieldedInvocationId,
  })
  await app.run(agent, { session })
}
```

Use `validateResumeState(session.events)` or `assertReadyToResume(session.events)` before resume logic that must fail fast on unresolved or invalid yields.

## Time Travel

Historical helpers support debugging, evals, and forks:

```typescript
const index = session.eventIndexOf(eventId)
const snapshot = session.stateAt(index)
const fork = session.forkAt(index)
```

Standalone utilities exported from the main entry:

- `snapshotAt`
- `computeStateAtEvent`
- `findEventIndex`
- `findInvocationBoundary`
- `validateResumeState`
- `assertReadyToResume`
- `createEventId`
- `createCallId`
