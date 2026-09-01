# Context And Sessions

Use this reference for context rendering, typed prompts, event ledger semantics, state scopes, stores, yield/resume, artifacts/provenance, and historical snapshots.

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
- `boundState(invocationId)`, `clone()`, `eventIndexOf(id)`, `stateAt(index)`, `forkAt(index)`, `onStateChange(cb)`.
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
