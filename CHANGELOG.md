# Changelog

<!--
Changelog guidelines:

IMPORTANT: Never rewrite historical entries. When an API is renamed or
removed, document the change in the NEW version's entry. Previous entries
must continue to use the names that were current at the time of that release.

The audience is a developer (or agent) upgrading the ADK who needs to know:
what changed, whether it affects them, and how to adapt. Optimise for
scan-ability — most entries should be understood from a single line.

Sections (use only those that apply):
  Added · Changed · Removed · Deprecated · Internal · Migration from X.Y.Z

Formatting:
- One terse bullet per change. Backtick all symbols and paths.
- Use — (em-dash) to separate the item from its description.
- Use → for renames and type changes (e.g. `old` → `new`).
- Removed items: state the replacement when one exists ("use X").
- Version summary: 1-2 line blurb below the heading when a release has a
  cohesive theme; skip for small or mixed releases.

Migration section:
- Only document changes where the upgrade path is non-obvious — if a rename
  or type change can be inferred from the Changed bullets, don't repeat it.
- Focus on semantic shifts: when the same API name now returns different data,
  has different timing, or requires a different mental model.
- Use a #### heading per topic, with a short prose explanation. Add a
  // Before / // After code block only when the prose alone is ambiguous.
-->

## [Unreleased]

### Fixed

- `output: '<session key>'` for a key declared with `.optional()`, `.nullable()`, or `.default()` around a primitive (`z.string().optional()` and the like) is now a raw-text output key like its unwrapped form — previously the wrapper hid the primitive from the shorthand, so the key took the schema path and the model's prose was parsed as a value (the first number in "last 7 days" became the output `"7"`).

## [0.6.0] - 2026-09-01

The first public release. The surface is smaller than 0.5.27 on purpose: what shipped without a consumer, without a test against real infrastructure, or under a name that described the wrong thing is gone, because removing it after publication costs a breaking change and removing it now costs nothing.

### Fixed

- `npm install @animahealth/adk` no longer fails with `ERESOLVE` — the optional peer ranges now co-resolve (`react` widened to `^18 || ^19`, `ink` pinned to the tested `^5`, `ink-text-input` to `^6`), and `@anthropic-ai/claude-agent-sdk` left the peer list — its published versions require `zod@4`, which cannot co-resolve with the ADK's `zod@3`, so declaring it fails the install outright even marked optional. It is not bundled either: install it yourself to use `@animahealth/adk/agents/coding/claude-code`, which names it on the missing-module error.
- Importing the ESM main entry (or `/testing`) no longer requires `openai` and `@ag-ui/core` to be installed — the build now code-splits, so lazy provider imports stay lazy instead of hoisting their SDKs' static imports to the entry's top level, and `/testing` uses the SDK-free `openai` model descriptor. A packaging gate (`verify-package-exports.cjs`) now walks each key-free entry's static import graph so this class cannot ship again.
- Provider SDKs the core loads lazily (`openai`, `@google/genai`, `@anthropic-ai/vertex-sdk`, `ws`) are now declared as optional peers, so package managers surface them instead of the first `import` failing.
- Concurrent first operations on a lazily-opened store no longer construct two instances — `SQLiteStore` and lazy vector providers (`sqliteVec`, `qdrant`, `voyage`) memoize the in-flight open, closing the window where a `':memory:'` database could silently drop one side's committed writes.
- `sqliteVec` filtered search no longer returns empty when every match ranks beyond its overfetch window — the KNN window now widens until `topK` matches are found or the collection is exhausted.
- Event dedup is now uniform across session stores: `InMemoryStore` skips already-stored event ids like the SQL stores, and the SQLite/Postgres stores no longer assign a duplicate `idx` when a committed batch overlaps stored events (which left `ORDER BY idx` unspecified).
- `memory(...).close()` on a never-used lazy index is a no-op instead of instantiating the provider (and creating its database file) just to close it.
- `PostgresStore.loadScopedState` no longer crashes on string-valued state (`'dark'`) — the JSONB driver already decodes values, and the redundant `JSON.parse` threw on any bare string.
- `DynamoDBStore.list()` now lists sessions (it was a stub returning `[]`); Scan-based — see its doc comment before using it on a large table.
- `pgvector` reads (`scroll`/`count`/`distanceMatrix`/`get`) no longer create the collection's table as a side effect — a missing collection reads as empty instead of failing on a dimension-less table whose index cannot build. Mutations on a missing collection are no-ops.
- Every documented store and vector backend now actually runs its shared compliance suite: `DynamoDBStore` and `PostgresStore` run the session-store suite and `pgvector` the vector-index suite against service containers in CI (the suite fixtures are now hygienic across tests on shared backends). The `qdrant` index deliberately does not run the vector suite — it is provisioning-based (collections and named-vector sets are fixed at creation via `collectionSpec()`), where the suite encodes lazy creation.
- `composeHooks`, `loggingHook`, `metricsHook`, and `cliHook` are now exported from the Core entry — only their option types were previously reachable, so a consumer could not construct any built-in hook at all.
- Registered model adapters now reach every entry point. `adk({ adapters })` was honoured by `app.run` but dropped by `app.handler.turn/rest/agui`, `app.handler.voice`, and `app.cli`, each of which built its own runner without them — so a served agent or a CLI could not be driven by a scripted adapter and demanded a real provider key instead. `HandlerConfig` and `VoiceHandlerConfig` now carry `adapters`, and a caller's override wins over the app's.
- A missing optional peer says which package to install instead of failing as a bare module-resolution error: `@animahealth/adk/stores/sqlite` names `better-sqlite3`, and `@animahealth/adk/cli` names `ink ink-text-input react` (its dependencies now load lazily, before the alternate screen is entered, so the message is visible rather than torn down with the process).
- `fetchPage` reports a missing HTML-extraction dependency as `missing_dependency` with the install line, rather than as `network_error` — which read as "the page is broken" and had models retrying a fault no retry could fix. `FetchPageResult.error` gains that member and an optional `errorMessage`.
- `webSearch()` builds its default Serper client on first use rather than at construction, so a module that merely defines a research agent no longer throws at import time without `SERPER_API_KEY`.
- The `/testing` matchers ship their types. `expect(...).toHaveToolCall()` and friends had no type declaration in `dist`, so TypeScript consumers saw an error on a matcher that worked at runtime.

### Changed

- `zod` peer floor raised to `^3.25.0`. The old `^3.22.0` was already fiction: `zod-to-json-schema` requires `^3.25.28 || ^4`, so npm resolves 3.25.x for every consumer regardless, and a project pinning 3.22–3.24 was installing on a peer warning rather than a satisfied range. The floor now says what the package actually needs.
- A zod 4 schema is refused at `adk({ schema })` and `app.tool(...)` instead of degrading in silence. This package reads zod 3 internals, and handed a v4 schema nothing throws: coercion stops (a `'5'` stays a string) and JSON-schema conversion falls back to `any`, so every tool reaches the model with its parameters erased. The check runs once, where a schema enters, and names the call that supplied it. Reaching this state is easier than it sounds — pnpm's `autoInstallPeers` links zod 4 for you as soon as another dependency asks for it.
- The Claude Agent SDK's missing-module error no longer tells you to run a command that cannot work. `npm install @anthropic-ai/claude-agent-sdk` fails outright: the SDK peer-requires zod 4, which will not co-resolve with this package's zod 3. The message now gives the recipe that does work — install with pnpm, and pin `zod@^3.25` in your own app so both resolve.

- `model()` in the test kit accepts a plain string as a text reply — `model('hello')`, symmetric with `user('hi')`. Previously a string produced a response with no `.text`: the adapter emitted nothing and the run "passed" with the reply silently gone.
- `OpenAIAdapter` is now exported from `@animahealth/adk/openai` — the documented `new OpenAIAdapter(endpoints)` + `adk({ adapters: { openai } })` seam for programmatic endpoint injection was previously unreachable (the class was not exported anywhere).
- `OpenAIEndpoint` gains `dangerouslyAllowBrowser` — passed through to the OpenAI/Azure client so a page where the END USER supplies their own key can construct the adapter in a browser. Never set it with a key the user did not type themselves.

### Removed

- `@animahealth/adk/executors` is gone, with the Docker, Modal, file-watch, artifact-sync and workspace-tool modules behind it (~5,300 lines). Nothing imported them but the barrel that exported them; they were never exercised against real Docker or Modal; and `workspaceTools()` shipped a `shell` tool guarded by a regex blocklist, which is not a sandbox. `createWorkspaceProvisioner` and the isolation strategies survive — they were the one load-bearing part — and now come from `@animahealth/adk/agents/coding`. Provisioning a coder somewhere other than the local filesystem is yours to build against that seam.
- `RunResult.stepEvents` is gone; read the ledger from `run.session.events`. The field was a copy of the session's events frozen when the run returned, under a name that described neither its scope nor its snapshot: "step" means one model call at the provider layer, and this carried the whole session. `run.usage` reports the session's accumulated total, as it always did. To keep a snapshot, spread it yourself: `[...run.session.events]`.
- `FunctionTool.requiresApproval` is gone. It was declared on the type but absent from `ToolConfig`, never copied by `app.tool`, and never read anywhere in the package — so no tool could ever set it and nothing would have acted on it. Human approval is the yielding-tool surface.
- `dockerode` and `@types/dockerode` left the manifest with the executors that used them.

- Experimental surfaces no longer reach the Core entry — `import { DockerExecutor } from '@animahealth/adk'` and friends are gone. `/executors` (all exports), `/agents/coding` (all exports, including the root-only `claudeCode`/`mockCodingAgent` aliases — use `createClaudeCodeAgent`/`createMockCodingAgent` from `@animahealth/adk/agents/coding`), and the knowledge module (`provisionClaudeProtocol`, `renderClaudeMd`, `renderRule`, `renderSettings` — now internal, no replacement) left the main barrel. A gate (`src/index.tier-boundary.test.ts`) keeps every fenced module's vocabulary out of the Core entry.
- The gateway/process-store surface (`createGateway`, `GatewayImpl`, `inMemoryProcessStore`, `postgresProcessStore`, `createInProcessExecutor`, and their types), the artifact services (`InMemoryArtifactService`, `postgresArtifactService`, `inferMimeType`, `createArtifactsProxy`), and channels (`InMemoryChannel`, `EventChannel`) are internal — removed from the main barrel with no subpath. They are proposals-stage machinery, not public SDK.
- SQLite backends — `SQLiteStore` / `sqliteStore()` (`/stores/sqlite`), the `sqliteIndex()` vector provider, and the `better-sqlite3` / `sqlite-vec` optional peers were dropped during the 0.5.20–0.5.27 line without a changelog entry; documenting here. Both surfaces are restored below (the vector provider returns as `sqliteVec`, not `sqliteIndex`).

### Added

- SQLite session store restored — `SQLiteStore` / `sqliteStore(dbPath)` return at `@animahealth/adk/stores/sqlite` over the optional `better-sqlite3` peer (`>=11`): zero-infrastructure durable sessions for local development, CLIs, and single-process deployments, passing the same store compliance suite as the in-memory and Postgres stores. `':memory:'` gives an ephemeral store.
- SQLite vector memory restored as `sqliteVec({ path })` — a config for `memory({ index })` like `qdrant(…)` / `pgvector(…)`, over the optional `better-sqlite3` + `sqlite-vec` peers (vec0 virtual tables, cosine metric). Successor to the removed `sqliteIndex()`; where the old provider's no-variant `scroll`/`count` read only the `default` variant, `sqliteVec` follows the in-memory reference (each id is one logical point).
- VectorIndex compliance suite — `runVectorIndexTests` (`src/memory/providers/index-compliance.test.ts`) now proves every index provider against one contract; the in-memory reference and `sqliteVec` both run it.

## [0.5.27] - 2026-08-20

### Added

- OpenAI explicit prompt caching — configure `OpenAIModel.promptCache` and mark the stable prefix with `app.context.cacheableUser(...)`; Responses API cache reads and writes are exposed through `ModelUsage` and `UsageSummary`.

## [0.5.25] - 2026-06-08

Republish of 0.5.24 with a packaging fix — no API or runtime changes.

### Fixed

- Published manifest — `@types/node` now publishes as a concrete range (`^22.19.19`) instead of the raw pnpm `catalog:` token. 0.5.24 shipped `"@types/node": "catalog:"`, which broke `pnpm pack` / `pnpm install` for anyone consuming the package outside the workspace it is published from, with `ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC`.

### Internal

- Publish pipeline — `adk-publish.yml` now packs with `pnpm pack` (which resolves `catalog:` / `workspace:` specifiers) and uploads the resulting tarball with `npm publish`, so the published manifest no longer leaks workspace-only specifiers while keeping npm OIDC trusted publishing. Publishing the source directory with `npm publish` shipped `package.json` verbatim, which is how the `catalog:` token reached 0.5.24.

## [0.5.24] - 2026-06-04

Workflows: author Claude Code-style `.workflow.js` files and run them through the ADK, plus a few general additions used to express them.

### Added

- `@animahealth/adk/workflow` — `runWorkflowFile()` runs a CC-style workflow file through `app.run`, binding `agent()` to a configurable node runner (default `app.ask`; a `CodingAgent` over a provisioned workspace for build attractors).
- `app.ask(prompt, opts)` — terse, typed one-shot LLM call (no tools, fresh session); options typed as `AskOpts`.
- `fanout(thunks, { limit })` — capped isolated concurrency; a failed thunk resolves to `null`.
- `AnnotationEvent` + `ctx.note()` — generic progress events (`phase()` / `log()` are sugar over `ctx.note()`).

### Changed

- Voice handler — end-of-invocation hooks (`afterAgent`/`afterTurn`) now run inside LiveKit's shutdown barrier, so completion side effects (e.g. `completeCall`) run exactly once before the worker exits — even on abnormal teardown (caller disconnect, human transfer, drop). Previously they were skipped if the job was killed before the post-`sessionDone` path ran.
- Voice handler — fixed `shutdownProcessTimeout` unit bug (`60`ms → `60_000`ms / 60s, matching LiveKit's default); the worker was force-killing job processes ~60ms into shutdown, before finalization could complete.
- Voice handler — `beforeAgent` returning a string now finalizes through the same shared path as any other call (completion hooks run), replacing a separate early-exit lifecycle.

## [0.5.23] - 2026-05-26

### Added

- Voice lifecycle diagnostics — added typed voice activity and lifecycle hook events to production/eval voice handlers, `voiceLoggingHook`, and voice eval reports.
- Voice playout tests — covered `ctx.voice.generateReply()` plus `reply.waitForPlayout()` from inside tool execution, including LiveKit awaitable speech handles.

### Changed

- LiveKit voice peers — raised `@livekit/agents` and provider plugin peer floor to `^1.4.4`, and bumped `@livekit/rtc-node` to `^0.13.28`, verified with child speech-handle playout waits inside tool execution.

### Fixed

- Voice output tools — model-initiated output-tool completion now stores the structured output internally without returning it to the realtime model, preventing final summaries from being spoken as a trailing assistant response.

## [0.5.22] - 2026-05-20

Voice output completion is now a visible, typed lifecycle step. Named voice tool forcing is handled inside the ADK without mutating the realtime tool list, so voice agents can reliably collect final structured output while preserving provider prompt caches.

### Added

- Voice forced-tool gate — `ctx.voice.generateReply({ toolChoice: { name } })` now enforces the named tool internally while sending provider-compatible `toolChoice: "required"`.
- Voice output completion telemetry — added `output_tool_completion_started`, `output_tool_completion_succeeded`, `output_tool_completion_failed`, `forced_tool_correction`, and `forced_tool_failure` voice events.
- Voice diagnostics — eval reports now include forced-tool and output-completion timelines with timestamps relative to case start.
- Voice errors — exported `ForcedToolCallError` and `OutputToolCompletionError` from `@animahealth/adk/voice`.
- Voice forced-tool gating — cache-stable named tool forcing is now a specified contract rather than an implementation detail.

### Changed

- Voice `ctx.end()` — ending tools now return their tool result before ADK forces the configured output tool and then shuts down the voice lifecycle.
- Voice output tools — output-tool completion timeout/failure is no longer treated as silent success; eval paths surface typed failures and production emits diagnostic voice events.
- Voice eval cleanup — teardown now uses bounded waits for tracker flush, LiveKit session close, recorder stop/disconnect, room disconnect, and room deletion.

### Fixed

- Voice forced tools — wrong tools are intercepted before tool execution and before app `beforeTool` hooks, then corrected after the synthetic wrong-tool result is returned to the provider.
- Voice forced tools — required generations that produce no tool call now retry with a generic correction naming `no_tool_call` and the intended tool.
- Voice shutdown — after-turn hooks, session commit, and call termination now run in a stable order after output finalization.

### Migration from 0.5.21

#### Voice output completion failures

Voice evals can now fail when the configured output tool is not actually completed. This is intentional: missing final structured output is now observable instead of being treated as best effort success. Production cleanup still runs after output completion failure.

#### Named voice tool choices

Applications no longer need app-level generic "wrong tool redirect" state for voice `toolChoice: { name }`. Keep domain-specific fallback logic in the application, but let the ADK own generic named-tool enforcement.

## [0.5.21] - 2026-05-19

### Added

- Voice evals — `app.evaluate.voice.case((control) => case)` now exposes `control.disconnectUser()`, letting eval code orchestrate caller disconnects from hooks, tool mocks, or other TypeScript code.

### Fixed

- Voice handlers — participant disconnect, inactivity, expiry, and `ctx.end()` paths now wait for the output tool to complete before room termination.
- Voice evals — transcript hooks now run in the voice harness, and participant-left cases can pass/fail on metrics after cleanup instead of always reporting as terminated.

## [0.5.20] - 2026-05-17

### Fixed

- Voice handlers — lifecycle hooks (`onInactivity`, `onExpiry`, `onDisconnect`) now run the active agent hooks together with handler hooks, matching voice eval behavior and allowing agent-owned inactivity prompts in production.
- Voice evals — expiry timeouts now run `onExpiry` hooks before ending the case, matching production timeout behavior.
- Artifact sync — file-watch artifact watchers now perform the documented final sweep on `stop()`, so missed filesystem watch events are still collected.
- Memory evals — the network-backed Voyage embedding eval now requires `ADK_RUN_VOYAGE_EVALS=1` in addition to `VOYAGE_API_KEY`, keeping default test and publish runs offline.

### Internal

- Package publishing — `@animahealth/adk` now publishes from this package's own source tree, with repository metadata to match.

## [0.5.19] - 2026-05-08

### Fixed

- Voice handlers — forced output-tool replies now wait for speech playout before ending the LiveKit room.

## [0.5.18] - 2026-05-08

### Fixed

- Voice `generateReply()` — preserves the entry-reply scheduling yield after capturing LiveKit's synchronous speech handle so `onEnter` replies do not race realtime session instruction updates.

## [0.5.17] - 2026-05-05

### Fixed

- Voice handlers — `ctx.end()` from a voice tool now waits for the model-triggered output tool and current playout to finish, then deletes the LiveKit room by default; use `callTermination: false` to leave hangup to the deployment.
- Voice `generateReply()` — LiveKit speech handles are now captured synchronously, named tool choices use LiveKit's `{ type: 'function', function: { name } }` shape, and `undefined` tool results stay `undefined` instead of being coerced to an empty string.

## [0.5.16] - 2026-03-26

### Changed

- `waitForPlayout` — added to `ToolExecutionContext` and `MockToolContext`; removed broken session-level `VoiceSession.waitForPlayout()`. Use `ctx.waitForPlayout?.()` in tools, `reply.waitForPlayout()` in lifecycle hooks.

### Fixed

- `dynamoStore` — unused `ExpressionAttributeNames` on non-create commits caused `ValidationException`.
- `dynamoStore` — scoped-state pk separator changed from `_` to `#` to prevent collisions when `scopeId` contains underscores. (unused in production currently)

## [0.5.15] - 2026-03-26

### Fixed

- `dynamoStore` — support custom key schemas via `partitionKey` / `sortKey` config options (defaults to `pk` / `sk` for backwards compat).

## [0.5.14] - 2026-03-24

### Fixed

- Coercion parser — use `_def.typeName` instead of `instanceof` so coercion works across Zod instances.
- Voice tool bridge — pass JSON Schema to LiveKit; validate with coercion in the ADK executor.
- `{}` on optional primitive fields now coerces to `undefined`.

## [0.5.13] - 2026-03-24

### Fixed

- Tool arg validation — run args through the coercion parser before `safeParse`, so malformed values are coerced instead of silently failing. Applies to all agent tool calls, yielding tools, and the LiveKit voice bridge.

## [0.5.12] - 2026-03-21

### Fixed

- Handler session key — `resolveSession` used `agent.name` instead of the app name; `app.sessions.get()` could never find handler-created sessions. `HandlerConfig.appName` is now required (`app.handler.*` injects it automatically).

### Removed

- `session.truncateAt()` — broke `commitSession` (cursor divergence). Use `session.forkAt()` instead.

## [0.5.11] - 2026-03-20

### Added

- `session.truncateAt(eventIndex)` — truncate event history in-place; unlike `forkAt`, mutates the same session.
- Memory `sample()` — large candidate pools now bypass the server-side distance matrix and compute diversity locally from raw vectors.

## [0.5.10] - 2026-03-20

### Fixed

- `toolInputsSchema()` — generated schema field `data` → `input` to match `ToolInput` consumed by `applyInput()`.

### Added

- `RestResponse.state` — rest handler returns session state when `response.state` is enabled.

## [0.5.9] - 2026-03-17

### Added

- Voice eval reports now include per-model-call cost and token breakdown.

### Fixed

- A single voice eval worker crash no longer aborts the entire suite.
- `ctx.end()` from the output tool no longer loops indefinitely.
- Orphaned eval workers handle `EPIPE`, closed IPC, and upstream `currentGeneration` throws gracefully.

## [0.5.8] - 2026-03-16

### Added

- `toolMocks` — output tools (`agent.output`) are now intercepted the same as regular tools; unmocked output tools throw `EvalToolError` when `toolMocks` is provided.

## [0.5.7] - 2026-03-16

### Fixed

- Voice eval — `requireLiveKit()` `await import()` → `require()` to fix dual-package hazard that silently prevented conversations from starting.
- Voice eval report — stale speech end timestamps from previous segments no longer produce backwards time ranges.

## [0.5.6] - 2026-03-15

### Changed

- `openai`, `gemini`, `claude`, `voyage`, `qdrant` — import from `@animahealth/adk/openai`, `/gemini`, `/claude`, `/voyage`, `/qdrant` instead of the main entry.

```typescript
// Before
import { adk, openai, voyage, qdrant } from '@animahealth/adk'

// After
import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'
import { voyage } from '@animahealth/adk/voyage'
import { qdrant } from '@animahealth/adk/qdrant'
```

## [0.5.5] - 2026-03-14

### Changed

- All optional dependencies (`openai`, `@google/genai`, `@anthropic-ai/vertex-sdk`, `pg`, `@qdrant/js-client-rest`, `voyageai`, `ws`, etc.) — `require()` → async `import()` so bundlers can tree-shake unused providers.
- `sqliteIndex(dbPath)` — now returns `Promise<VectorIndex>`; callers must `await`.

## [0.5.4] - 2026-03-08

### Added

- `app.hook.voice()` — typed entry point for custom voice hooks; accepts `Partial<VoiceHook<S>>` and returns `VoiceHook<S>`. Mirrors `app.hook()` for standard hooks.
- `VoiceHook.onTranscript` — fires for each user or assistant transcript message with full context (`session`, `state`, `voice`, `event`) and `ctx.run()` for text-mode sub-agent orchestration. Runs in a dedicated queue that never blocks the voice pipeline; drained before session commit so in-flight state mutations are preserved.
- `VoiceSession.turnCount` — number of user speech segments (blocks of continuous user speech). Incremented each time the user starts speaking. Use `ctx.voice.turnCount > 0` to determine if the caller has engaged.
- Output tool auto-trigger — when an agent has an `output` tool and `turnCount > 0`, the ADK automatically triggers it via `generateReply({ toolChoice: 'required' })` on lifecycle events (disconnect, inactivity, expiry). Hooks no longer need to manually force the output tool.
- `ctx.end()` — synchronous control signal (like `ctx.output()`) that triggers the agent's output tool via the model. Return it from a tool's `execute` to end the session with model-generated output: `return ctx.end()`. Voice mode triggers `generateReply`; text mode sets `endInvocation`.
- `ctx.run()` / `ctx.spawn()` / `ctx.dispatch()` in voice mode — voice tools can now run text-mode sub-agents inline. Backed by `BaseRunner`; the sub-agent runs in the same session while the voice session continues.
- `VoiceHandlerConfig.prewarm` — optional per-subprocess init callback, called by LiveKit before any job runs (e.g. Sentry, OpenTelemetry setup)
- Schema defaults — Zod `.default()` values declared in `stateSchema` are now applied to initial state across all entry points (voice setup, REST/AG-UI handlers, `app.run()`, test runner, voice evals). Setup functions no longer need to manually mirror defaults.
- `SessionSetup.noiseCancellation` — per-session noise cancellation profile set in `setup()`. Overrides handler-level `sound.noiseCancellation` when present.
- `app.evaluate.report(options?)` — factory that returns `(result) => string`. Configure once, call with any eval result. Replaces `app.report(result, options)`.
- `app.evaluate.voice.report(options?)` — voice-specific report factory with narrowed types; `renderCase` receives `VoiceEvalCaseResult` with `run.transcript`, `run.timing`, `run.recording`.
- `BaseEvalCaseResult` / `BaseEvalResult` — shared base types for text and voice eval results; `EvalCaseResult` and `VoiceEvalCaseResult` both extend `BaseEvalCaseResult`.
- `ReportOptions<S, R>` — now generic over result type `R`; `renderCase`, `sections`, and `footer` callbacks receive the correct result/case types.
- `MetricResult.data` — optional `Record<string, unknown>` for attaching arbitrary structured data (computed values, intermediate measurements, debug info) to metric results.
- `app.evaluate.case()` / `.cases()` / `.metric()` — identity helpers for type-safe eval config definition; provides schema inference without runtime overhead.
- `app.evaluate.voice.case()` / `.cases()` — identity helpers for voice eval cases.
- `app.initialState()` — identity helper for typed multi-scope initial state config.
- `MockToolContext.voice`, `.output()`, `.end()`, `.run()` — expanded mock context surface; tool mocks can now test voice state, output signals, end signals, and sub-agent handoffs.
- `Input.initialState` / `SessionSetup.initialState` — multi-scope state seeding via handler input and voice setup; seeds `session`, `user`, `patient`, `practice`, `org`, `team` scopes in one call.
- `EvalOptions.repeat` / `VoiceEvalOptions.repeat` — run each case N times; results carry `repeatIndex` and `repeatTotal` metadata. Reports auto-group repeated cases with pass-rate summaries.
- `BaseEvalCaseResult.repeatIndex` / `.repeatTotal` — present when `repeat > 1`; structured repeat metadata replaces name-mangled `[i/n]` suffixes.
- Voice eval process isolation — when `concurrency > 1`, each voice eval case auto-forks into its own child process with an independent event loop and native thread pool. Eliminates WebRTC contention at high concurrency.

### Changed

- Generic parameter order — `Agent<TOutput, S>` → `Agent<S, TOutput>` (and `AgentConfig`, `OutputConfig`, `RunResult`, `AgentSpec`); `Agent<unknown, MySchema>` simplifies to `Agent<MySchema>`
- `ctx.output()` in voice mode — output signal is ignored when `turnCount === 0` (no user engagement). A voice session with no user turn cannot produce meaningful output; the session ends through the lifecycle event (disconnect, inactivity) instead of `completed`.
- `SoundConfig.noiseCancellation` — `boolean | unknown` → `'general' | 'telephony'`. Resolves to `BackgroundVoiceCancellation` or `TelephonyBackgroundVoiceCancellation` from `@livekit/noise-cancellation-node` internally. Replace `true` with `'general'`.
- `VoiceEvalOptions.room` — now optional; defaults to `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` env vars.
- Voice eval default timeout — 480s → 300s (5 min).
- `StateChanges<S>` — now generic over state schema for typed multi-scope seeding.
- `MetricRun<S>` — now generic over state schema; `Metric<MetricRun<S>>` provides typed `session` access.

### Removed

- `app.report()` — use `app.evaluate.report()` instead
- `repeatCases()` — use `EvalOptions.repeat` / `VoiceEvalOptions.repeat` instead
- `parseRepeatName()` — repeat metadata is now structured (`repeatIndex`, `repeatTotal`) on result objects

### Fixed

- Voice thinking sounds — pre-decoded into memory at session start; eliminates ffmpeg subprocess spawn and stutter on first play
- Voice handler cleanup — cancel speech wait and stop thinking sound on session end; prevents dangling timers after disconnect.
- Voice handler lifecycle — state guard before `beforeEnd` callback prevents double-end race when multiple lifecycle events fire concurrently.
- Voice handler transcript drain — 10s timeout cap prevents hanging when the transcript queue stalls on disconnect.
- Voice eval inactivity timer — now resets on agent activity and fires `onInactivity` hooks, mirroring production handler behavior.

### Migration from 0.5.3

#### Generic parameter order: `<TOutput, S>` → `<S, TOutput>`

```typescript
// Before
Agent<unknown, typeof schema>
Agent<string, typeof schema>

// After
Agent<typeof schema>
Agent<typeof schema, string>
```

#### `app.report()` → `app.evaluate.report()`

Report is now a factory — configure options up front, call the returned function with a result. This lets you define reports in a separate file without having the result available.

```typescript
// Before
const md = app.report(result, { title: 'My Eval' })

// After
const report = app.evaluate.report({ title: 'My Eval' })
const md = report(result)

// Voice — renderCase receives VoiceEvalCaseResult with full inference
const voiceReport = app.evaluate.voice.report({
  renderCase: (r) => r.run.transcript.map((t) => t.text).join('\n'),
})
```

## [0.5.3] - 2026-03-05

Voice evaluation framework — run voice agents through real LiveKit rooms with a simulated user agent, collect transcripts and timing data, and measure outcomes with voice-specific metrics.

### Added

- `evaluateVoice(cases, options)` — runs `VoiceEvalCase[]` through LiveKit rooms with real audio; returns `VoiceEvalResult` with per-case transcripts, timing, recordings, and metrics
- `VoiceEvalCase` — defines agent under test, simulated `userAgent`, optional `toolMocks`, per-case `metrics`, `retries`, and `timeout`
- `VoiceEvalOptions` — suite config: `room` (LiveKit URL + credentials), `output` directory for per-case reports and recordings, `concurrency`, `stopOnFirstFailure`, `onCase` progress callback, and suite-level `metrics` and `hooks`
- `VoiceRunResult` — run output with `transcript: TranscriptEntry[]`, `timing: VoiceTiming`, `recording: { path }`, `events`, `session`, `usage`, and `durationMs`
- `VoiceTiming` — timing data: `timeToFirstSpeechMs`, `responseTimes`, `silenceGaps`, `interruptions` (count, byAgent, byUser), `vadResolutionMs`
- `voiceTimingMetric(config)` — metric factory for voice timing measures: `time_to_first_speech`, `response_latency_p50`, `response_latency_p95`, `response_latency_max`, `silence_gap_max`, `silence_gap_total`, `interruption_count`
- `createSpeakerTracker()` — tracks agent/user speech segments for transcript and timing computation
- `TranscriptEntry` — `{ role, text, startMs?, endMs?, turnIndex }`
- `ToolContext.waitForPlayout` — opt-in helper for tools that need to wait for pending agent speech to finish
- `VoiceHook.onEnter` — fires when an agent becomes active (initial entry and after transfer); replaces default auto-speak when defined
- Voice handler auto-speak — calls `generateReply({ toolChoice: 'none' })` on agent activation when no `onEnter` hook is defined

### Changed

- Voice handler `onEnter` — no longer auto-speaks when no hooks are defined; add an explicit `onEnter` hook to greet the caller
- `VoiceEvalOptions.recording` → `VoiceEvalOptions.output`

### Fixed

- Voice thinking sounds — deferred until agent speech playout completes; tool execution itself is not blocked
- Voice inactivity timer — resets on actual speech start instead of transcript arrival; no longer fires while agent is thinking or speaking

### Removed

- `Agent.greeting`, `GreetingContext` — move greeting content into system prompt; use `onEnter` for ephemeral instructions

## [0.5.2] - 2026-03-02

### Internal

- Fix ESM `require()` shim — inject `createRequire` banner in tsup ESM output so lazy `require()` calls resolve correctly (fixes `"Dynamic require of X is not supported"`)
- Remove `lodash` dependency — `isEqual` → `node:util.isDeepStrictEqual`

## [0.5.1] - 2026-03-01

Realtime voice agents — OpenAI and Gemini realtime adapters, LiveKit voice handler, native agent yield/resume loops with greeting and timeout support, structured session completion via output tools, and app-owned session management.

### Added

- `realtime()` / `openai.realtime()` / `gemini.realtime()` — wraps a provider model for realtime use; text-mode agents use native WebSocket adapters, full audio pipeline (with `stt` + `tts`) falls through to the standard adapter
- `@animahealth/adk/voice` subpath — LiveKit voice handler; `ctx.voice` (`VoiceSession`) available in tools for `generateReply`, `waitForPlayout`, `interrupt`; `app.handler.voice(config)` on the handler namespace
- `OutputConfig` accepts a `FunctionTool` — pass `app.tool()` as `agent.output` for tool-injection output mode; framework injects the tool, validates args, runs `execute`, captures output, and manages shutdown
- `VoiceHook` — extends `Hook` with `onInactivity`, `onExpiry`, `onDisconnect` lifecycle callbacks; defined inside the unified `hooks` array on `VoiceHandlerConfig`. Return `false` to keep session alive, `true` to explicitly end. Multiple hooks compose: any `false` vetoes end
- `VoiceHandlerConfig.timeouts` — handler-level `{ inactivity?, expiry? }` defaults; per-agent `timeouts` override them after transfers
- `VoiceSession.generateReply()` accepts full `ToolChoice` — adds `'required'` and `{ name: string }` for forcing specific tool calls in lifecycle hooks
- `Agent.yields` — yield for user input after terminal model output instead of completing; defaults to `true` for realtime models. `Agent.maxTurns` caps yield/resume cycles (default: 100; produces `status: 'max_turns'`)
- `Agent.greeting` — string or `(ctx: GreetingContext) => string | Promise<string>`; injected as system event on first activation only, not on resume
- `Agent.timeouts` — `{ inactivity?, expiry? }` in ms; produces `status: 'inactivity_timeout'` or `status: 'max_duration'`
- `ctx.output(value)` on `ToolContext`, `ToolExecutionContext`, `StepContext` — ends the invocation early; value becomes `RunResult.output.value`
- `adk({ store })` — optional `SessionStore` on the app factory; defaults to in-memory. `app.sessions` exposes `create`, `get`, `delete`, `list`, `commit`, `merge` pre-bound to the app name
- `inMemoryStore()`, `dynamoStore()`, `sqliteStore()`, `postgresStore()` — store factory functions; class constructors deprecated
- `UsageSummary.models` — per-model `ModelUsageEntry[]` with `calls`, token counts, and per-model `cost`. `ModelUsage` gains `audioInputTokens`, `audioOutputTokens`, `audioCachedTokens` for realtime models
- `UserEvent.source`, `AssistantEvent.source` — `'text' | 'transcript'` distinguishes direct text from audio transcription
- Realtime model pricing — `gpt-realtime-*`, `gpt-4o-realtime`, `gpt-4o-mini-realtime`, `gemini-*-native-audio`, `gemini-live-*`
- `@livekit/agents`, `@livekit/agents-plugin-openai`, `@livekit/agents-plugin-google` — optional peer dependencies

### Changed

- `ctx.call()` → `ctx.run()`, `CallResult` → `SubRunResult`, `CallResultTransfer` → `SubRunResultTransfer` — old names are deprecated aliases until 0.6.0
- `AgentTimeouts.maxDuration` → `AgentTimeouts.expiry` (deprecated alias `maxDuration` still works)
- `ModelEndEvent.modelName` → `ModelUsage.modelName` — model name now lives on the usage object; code reading `event.modelName` on `model_end` events must switch to `event.usage?.modelName`
- `Hook.afterAgent` — output parameter widened `string` → `unknown`; typed hooks with explicit `string` signatures need updating
- `HandlerConfig.sessionService` — now optional; handlers auto-inherit the app's session service
- `calculateCost(usage, modelName)` → `calculateCost(usage)` — model name read from `usage.modelName`
- `formatCost` — sub-dollar amounts use `toFixed` instead of `toPrecision`
- `RunStatus` — `'inactivity-timeout'` → `'inactivity_timeout'`, `'max-duration'` → `'max_duration'`, `'participant-left'` → `'participant_left'`; added `'disconnected'` and `'participant_left'` as first-class statuses (previously collapsed to `'aborted'`)
- `InvocationEndReason` — same underscore renames as `RunStatus`; `InvocationEndReason` is now a strict subset of `RunStatus`
- `InvocationState` — limit end reasons (`max_steps`, `max_turns`, `max_duration`, `inactivity_timeout`, `disconnected`, `participant_left`) map to `'completed'` instead of their raw reason string
- `BaseRunner` — `sessionService` constructor option is now optional (defaults to in-memory)
- `computeResumeContext()` — multi-turn resume no longer bails early when a prior turn's root invocation is terminal; the `findYieldedNodes` scan already handles "nothing to resume"

### Deprecated

- `AgentTimeouts.maxDuration` — use `expiry` instead. Will be removed in 0.7.0.
- `sessionService()` factory — use `adk({ store })` and `app.sessions`
- `InMemoryStore`, `DynamoDBStore`, `PostgresStore`, `SQLiteStore` classes — use `inMemoryStore()`, `dynamoStore()`, `sqliteStore()`, `postgresStore()`
- `app.session()` — use `app.sessions.create()`
- Standalone `turn()` — use `app.handler.turn()`

### Removed

- `ModelEndEvent.modelName` — use `ModelUsage.modelName`
- `gemini-2.5-flash` high-tier pricing bracket (price changed)

## [0.5.0] - 2026-02-23

Eval API moves onto the app (`app.evaluate`, `app.report`), with full `RunResult` preserved per case and markdown report generation for persistent, agent readable, git-checkable records.

### Added

- `app.evaluate(cases, options)` — runs eval cases (single or array) with tool mocking and metrics; returns `EvalResult<T, S>` with app state `S` and optional per-case context `T`
- `app.report(result, options)` — generates markdown from `EvalResult`; optional `title`, `footer` (string or function), `sections`, and `renderCase` for custom content
- `EvalCaseResult.run` — full `RunResult` (session, usage, output) preserved for reporting and metrics; convenience accessors `.events`, `.usage`, `.turns`
- `EvalOptions.onCase` — progress callback `(result, index, total) => void` called after each case completes
- `EvalCase.retries` — number of additional attempts for flaky cases; retries on `failed`, `error`, or `timeout`
- `EvalCase.timeout` — per-case timeout in ms; produces `status: 'timeout'` on expiry
- `TestOptions.maxTurns` — replaces `maxIterations` for consistency with `SimulateOptions`
- `RunResult.state` — typed `TypedState<S>` accessor (same type as `result.session.state`); symmetric with `input: { state }` on the input side
- `AssistantEvent.media` — optional `MediaPart[]` field; eliminates the need to cast when accessing media on assistant events
- `Session.boundState(invocationId)` — returns invocation-scoped `TypedState`; useful in custom context renderers
- `Session.onStateChange(callback)` — registers a state change observer
- `Session.getSpawnedTaskStatus(id)`, `Session.getRunningSpawnedTasks()`, `Session.getAllSpawnedTasks()`, `Session.waitForSpawnedTask(id)`, `Session.waitForAllSpawnedTasks()`, `Session.hasRunningSpawnedTasks()` — spawned task observation from hooks and tools
- `VectorFilter` nested filters — `must`, `should`, `must_not` arrays now accept nested `VectorFilter` objects for compound boolean logic (e.g. AND-within-OR for per-slice filtering)
- `mem.slices(names)` — subset accessor for searching, sampling, and filtering across a selected set of slices in one call; return type narrows to only the selected slice types
- `SlicedSubset<TSlices>` — type for the object returned by `mem.slices()`
- `mem.variant.summary.returning('detailed')` — cross-variant content: search using one variant's embeddings, return another variant's content

### Changed

- Parser structured output — path-scoped visited key (no false circular ref); valid `partial` used on parse failure when it passes schema
- `EvalCase` — composes shared fields with `SimulateOptions` via `Pick`; `initialState` + `firstMessage` replaced by standard `input` (string or `{ message, state }`)
- `EvalCaseResult` — now `EvalCaseResult<S>` with `run: RunResult<unknown, S>`; `tokenUsage` → `usage` (type `UsageSummary`); `events` and `turns` preserved as convenience accessors
- `Metric.evaluate` — signature `(events: Event[])` → `(run: RunResult)`; events available as `run.session.events`; built-in metric factories updated
- Eval error shape — `error` on `EvalCaseResult` is now `{ message: string; stack?: string }`; `EvalError` interface and `phase` field removed
- Eval status mapping — `aborted` run status now maps to `EvalStatus: 'aborted'` instead of falling through to pass/fail; metric name collisions between suite and case level emit a console warning
- `app.handler.rest` / `app.handler.agui` / `app.handler.turn` — now inherit app-level `hooks` and `errorHandlers`; handler-level config composes after app-level (app hooks run outer, handler hooks run inner)
- `app.cli` — now inherits app-level `hooks`, `errorHandlers`, and `appName` for session creation; CLI-level hooks compose after app-level; respects user-provided `runner` override
- Untyped state scopes return `unknown` instead of `any` — accessing properties on scopes without a schema (e.g. `state.user.name` when no `user` schema is defined) now requires explicit narrowing
- `mem.variant` renamed from `mem.variants`
- Memory internal key separator `#` → `_` — vector names (`model#variant` → `model_variant`), metadata prefixes (`_variant#` → `_variant_`, `_slice#` → `_slice_`); existing collections must be re-indexed
- `ModelStartEvent` — `messages: ContextMessageSummary[]` → `messageCount: number`; `serializedSchema` removed. The CLI reconstructs exact context on-demand via `session.forkAt()` + `buildContext()` when the user expands a context block. Eliminates O(n²) storage of repeated context snapshots.
- `SlicedMemory.slices` → `SlicedMemory.slice` — singular accessor for per-slice operations (`mem.slice.medication.search()`); `slices` is now the subset method
- `eventCountMetric` / `eventSequenceMetric` — `filter` callback infers narrowed event type from `eventType`; casts no longer needed. `Metric<S>` threads the app's state schema through `run.state`

### Internal

- Voice lifecycle state machine (`idle → active → ending → ended`) with atomic `tryEnd()` — first caller wins, concurrent shutdown events are safely ignored
- ADK-owned inactivity timer replaces LiveKit `userAwayTimeout` — supports repeated firings and `inactivityCount` reset on user speech

### Removed

- `Simulator` type — removed from main package and `adk/eval` exports (was the literal signature of `app.simulate`)
- `llmJudge` / `LlmJudgeConfig` — removed from `adk/eval`; implement the `Metric` interface directly with your own judge agent (see migration below)
- `runEval` / `runEvalSuite` / `EvalSuiteConfig` — use `app.evaluate(cases, options)`
- `EvalError` — use `error?: { message: string; stack?: string }` on `EvalCaseResult`
- `EvalCaseResult.tokenUsage` — use `result.usage` (`UsageSummary`)
- `EvalCase.initialState` / `EvalCase.firstMessage` — use standard `input` (`string` or `{ message, state }`)
- `TestOptions.maxIterations` → `TestOptions.maxTurns`
- `toolCallCountMetric` — use `eventCountMetric` with `eventType: 'tool_call'` and a `filter`
- `durationMetric` — use `timingMetric` with `measure: 'total_duration'`
- `modelLatencyMetric` — use `timingMetric` with `measure: 'model_latency_average'`
- `timeToFirstResponseMetric` — use `timingMetric` with `measure: 'time_to_first_assistant'`

### Migration from 0.4.x

#### EvalCase: `initialState` / `firstMessage` → `input`

`EvalCase` now uses the standard `input` field (same as `app.run` and `app.simulate`) instead of separate `initialState` and `firstMessage` fields.

```typescript
// Before
{ initialState: { session: { orgId: 'org-1' } }, firstMessage: 'Hello' }

// After
{ input: { message: 'Hello', state: { orgId: 'org-1' } } }
// or just: { input: 'Hello' }
```

#### Custom metrics: `(events)` → `(run)`

Metrics receive the full run; events are on `run.session.events`.

```typescript
// Before
const metric = {
  name: 'my_metric',
  evaluate: (events: Event[]) => {
    /* ... */
  },
}

// After
const metric = {
  name: 'my_metric',
  evaluate: (run: RunResult) => {
    const events = [...run.session.events]
    // ... same logic, or use run.usage, run.output, run.session.state
  },
}
```

#### `llmJudge` → custom `Metric`

`llmJudge` assumed a fixed transcript format and generic pass/fail schema. Implement `Metric` directly with your judge agent; the metric now receives `RunResult` so you can pass session or output into the judge.

```typescript
// Before
import { llmJudge } from '@animahealth/adk/eval'
const metric = llmJudge({
  name: 'quality',
  prompt: '...',
  model: openai('gpt-5-mini'),
  passingScore: 0.8,
})

// After
import type { Metric, MetricResult } from '@animahealth/adk/eval'
return {
  name: 'quality',
  evaluate: async (run): Promise<MetricResult> => {
    // build input from run.session.events or run.output, then run judge agent
    const { output } = await app.run(judgeAgent, { input: judgeInput })
    return {
      passed: output.value!.score >= 0.8,
      score: output.value!.score,
      evidence: [output.value!.reasoning],
    }
  },
}
```

## [0.4.6] - 2026-02-20

### Added

- `handler.turn` — shared streaming lifecycle (resolve session, run, stream events, commit, resolve conflict); returns `StreamResult<TurnResult>` with `invocationId` on the stream; use for custom projections (Slack, cron, CLI) without duplicating persistence
- `Hook.afterTurn` — turn-level lifecycle hook that runs within the `handler.turn` commit boundary (after run completes, before `commitSession`); state mutations are included in the commit atomically; receives `TurnContext` with session, result, and runnable
- `TurnContext` — context type for `afterTurn`; provides writable session, `RunResult`, and the runnable
- `CommitStatus`, `TurnResult` — `TurnResult` extends `RunResult` with `sessionId`, `invocationId`, optional `commitStatus` (`'committed' | 'merged' | 'skipped' | 'orphaned'`)
- `RunConfig.invocationId` — optional root invocation ID; when set, runner uses it instead of generating one (enables traceability with AG-UI `runId`)
- `RunConfig.errorHandlers` — per-run error handlers, composed after runner and agent handlers (mirrors `RunConfig.hooks`)
- `sqliteIndex()` — SQLite vector index provider via `sqlite-vec` with auto-provisioning
- `voyage()` `sagemaker` option — SageMaker endpoint with automatic fallback to Voyage API; each path retries independently
- `VectorCondition.range` — string bounds for datetime range filtering across all providers
- `VectorCondition.text` — case-insensitive text matching on string metadata fields; `contains` accepts `string | string[]` (array = OR)
- `SearchOptions.contains` — shorthand for text matching against stored content
- `CollectionSpec.textIndexes` — payload field names that need a text index for content search (Qdrant)
- `normalizeFilter()` — filter shorthand: `{ org: 'acme' }` expands to `{ must: [{ key: 'org', match: { value: 'acme' } }] }`; all filter-accepting methods (`search`, `context`, `tool`, `sample`, `scroll`, `count`) accept the shorthand via `FilterInput`
- `slices` config on `memory()` — heterogeneous collections with per-slice typed metadata; `records.slices.medication.search()` returns `SearchResult<MedicationMeta>`, `records.search()` returns a discriminated union with `match.kind` for narrowing (renamed to `records.slice` in 0.5.0)
- `SlicedMemory`, `SliceAccessor`, `SlicedMatchUnion`, `SlicedSearchResult` — types for sliced memory
- `CollectionSpec.payloadIndexes` — auto-populated with `_slice#kind` when slices are declared
- `Match.kind` — optional; present when the document belongs to a slice
- `better-sqlite3`, `sqlite-vec`, `@aws-sdk/client-sagemaker-runtime` — optional peer dependencies

### Changed

- `handler.agui` — delegates to `turn`; events stream live (no buffering until commit); AG-UI `runId` is the turn’s `invocationId`; `RUN_FINISHED` result payload includes `commitStatus` for reconciliation
- `handler.rest` — delegates to `turn` internally; external contract (buffered JSON response) unchanged
- `resolveConflict` return type — `ConflictOutcome` → `CommitStatus` (same values, adds `'committed'` for happy path)
- `UpsertItem.content` — now required; content is stored alongside vectors and returned as `Match.content`
- Upsert metadata — merge semantics across variants instead of replace
- `CollectionSpec.textIndexes` — Qdrant users should provision text indexes from this field to enable `SearchOptions.contains`
- `VoyageModel.dimensions` — now required; `voyage('voyage-4')` → `voyage('voyage-4', { dimensions: 1024 })`
- `MemoryConfig.variant` → `MemoryConfig.variants` — singular string replaced by string array; omit for implicit `['default']`
- `mem.variant('name')` → `mem.variants.name` (changed to `variant` in 0.5.0) — dynamic method replaced by upfront property map
- `collectionSpec(config, variants)` → `collectionSpec(config)` — variants now read from `config.variants`
- Internal metadata prefix `_content#` → `_variant#`; `_slice#` reserved for slices

### Removed

- `createRunId()` — use `turn(config, input).invocationId` (or the root invocation ID from the stream) as AG-UI `runId`
- `ConflictOutcome` — replaced by `CommitStatus` (import from handler or runtime types)
- `vectorKey()` — no longer public; use `collectionSpec()` instead
- `EmbedResult`, `Point`, `VectorMatch`, `DistanceMatrixPair`, `DistanceMatrixResult` — removed from top-level exports (importable from `@animahealth/adk/memory` for custom providers)
- `MemoryContextConfig`, `MemoryToolConfig` — removed aliases; use inline `mem.context()` / `mem.tool()` config

### Migration from 0.4.5

#### Memory variant API

```typescript
// Before
const mem = memory({ ..., variant: 'questionnaire' });
const full = mem.variant('full');

// After
const mem = memory({ ..., variants: ['questionnaire', 'full'] });
const full = mem.variants.full; // (changed to `variant` in 0.5.0)
```

#### Memory `collectionSpec` signature

```typescript
// Before
collectionSpec({ model, collection }, ['questionnaire', 'full'])

// After
collectionSpec({ model, collection, variants: ['questionnaire', 'full'] })
```

## [0.4.5] - 2026-02-15

### Added

- `memory()` — composable vector memory; typed metadata via Zod schema, provider-agnostic `Embedder` / `VectorIndex` interfaces
- `voyage()` — Voyage AI embedding provider with batching (128/request), automatic `inputType` routing, retry
- `qdrant()` — Qdrant vector index provider with retry
- `pgvector()` — pgvector vector index provider (PostgreSQL) with auto-provisioning, HNSW indexing, retry
- `inMemoryIndex()` — in-memory vector index with real cosine similarity for testing and prototyping
- `mem.context()` — returns `ContextRenderer` for deterministic recall before reasoning
- `mem.tool()` — returns `FunctionTool` for agent-driven recall via tool call
- `mem.search()` — returns typed `Match<TMetadata>[]` and computed embedding for downstream forwarding
- `mem.upsert()` — batch-aware write accepting `content` (embeds) or pre-computed `embedding`; validates dimensions
- `mem.updateMetadata()` — merge metadata without re-embedding; `null` deletes keys
- `mem.variant()` — named vector variants sharing collection, schema, and providers
- `mem.sample()` — representative sampling via density-weighted farthest-point selection; optional query-focused mode with gravity
- `vectorKey()` — exported so provisioning scripts, Terraform generators, and migration jobs can compute the same `model#variant` vector names the ADK uses internally
- `collectionSpec()` — computes collection vector specifications from memory config for provisioning
- `representativeSample()`, `estimateDensity()` — exported sampling utilities for custom workflows
- `Embedder`, `EmbedResult`, `VectorIndex`, `Match`, `Point` — exported types for custom provider implementations
- `voyageai`, `@qdrant/js-client-rest`, `pg` — optional peer dependencies

## [0.4.4] - 2026-02-11

### Added

- Event type guards — `isToolCallEvent`, `isToolYieldEvent`, `isToolInputEvent`, `isToolResultEvent`, `isAssistantEvent`, and 10 more for every `Event`/`StreamEvent` member
- `SimulateYieldContext` exported from main entry point

### Changed

- `SimulateYieldContext`, `Transform`, `SimulateOptions` — now generic over `TArgs` (defaults to `unknown`) so `Transform` callbacks can type `ctx.args` without casting

## [0.4.3] - 2026-02-11

### Changed

- Eval, run, test, simulate, CLI, and handlers — `Runnable`/`Hook` at orchestration boundaries widened to `Runnable<any>` / `Hook<any>[]` so typed agents and hooks work without casts

## [0.4.2] - 2026-02-10

Exports the eval framework as `@animahealth/adk/eval` and moves simulation termination into the core run loop.

### Added

- `@animahealth/adk/eval` — subpath export: `runEval`, `runEvalSuite`, `interceptTools`, metric factories, types
- `SimulateOptions.maxTurns`, `.maxDuration`, `.stateMatches` — flat termination fields replacing `maxIterations`
- `RunStatus: 'terminated'` with `terminationReason: TerminationReason` on the result
- `SimulateOptions.userAgent` is now optional — tool-only flows no longer need a stub

### Changed

- `SimulateOptions.maxIterations` → `maxTurns`
- `EvalSuiteConfig.parallel: boolean` → `concurrency: number` (defaults to `Infinity`; use `1` for sequential)
- `runEval` / `runEvalSuite` — first arg is now a `Simulator` function (pass `app.simulate`)

### Removed

- `SimulateOptions.maxIterations` — use `maxTurns`
- `EvalSuiteConfig.parallel` — use `concurrency`

### Migration from 0.4.1

#### Max-iterations status change

`maxIterations` exceeded previously returned `status: 'error'`. It now returns `status: 'terminated'` with `terminationReason: 'maxTurns'`. Code that checked `result.status === 'error'` for iteration limits must check `'terminated'` instead.

## [0.4.1] - 2026-02-09

### Added

- `app.hook()` — callable hook namespace for typed custom hooks, mirroring `app.context()`
- `createEventId` / `createCallId` — exported from public API

### Changed

- `ToolYieldEvent.preparedArgs` → `ToolYieldEvent.args`
- `yieldedTools` — returns `ToolYieldEvent[]` instead of `ToolCallEvent[]`
- CLI — pending yields show enriched `tool_yield` args instead of raw `tool_call` args
- OpenAI — synthetic call IDs normalized to `fc_` prefix at serialization boundary

### Migration from 0.4.0

#### `yieldedTools` returns `ToolYieldEvent[]` instead of `ToolCallEvent[]`

`session.yieldedTools`, `RunResult.yieldedTools`, and `RestResponse.yieldedTools` now return the enriched `ToolYieldEvent` (with `prepare` args) instead of the raw `ToolCallEvent`. Code that accessed `yieldedTools[n].args` continues to work — the args are now the enriched version from `prepare`.

## [0.4.0] - 2026-02-09

Consolidates the public API with a canonical `Input`/`Output` pair — descriptive yield statuses, unified media and tool, namespaced handler payloads, fewer redundant types.

### Changed

- `RenderContext` — all fields are now `readonly`; context renderers must return new objects instead of mutating
- `RunResult.status` — `'yielded'` → `'yielded_tool'`, `'input_required'` → `'yielded_message'`; each branch of the discriminated union carries only its relevant fields
- `app.run()` / `app.test()` / `app.simulate()` / `ctx.call()` (renamed to `ctx.run()` in 0.5.1) / `ctx.spawn()` — typed `Agent<TOutput>` overloads that preserve output type through to the result
- `ImageSource` / `AudioSource` / `DocumentSource` → `MediaSource`; `MessageInput.images` / `.audio` → `media: MediaPart[]`
- `ToolInput` / `ResultInput` → `ToolInput { callId, input }`; `session.input.tool()` now handles both tool yields and tool call results
- `TestOptions` — `messages` → `userHandler`, `tools` → `toolHandlers`; `SimulateOptions` / `EvalCase` — `simulator` → `userAgent`, `tools` → `toolAgents`
- `Hook | Hook[]` → `Hook[]` — hooks options now only accept an array; wrap a single hook in `[hook]`
- `CallOptions` / `SpawnOptions` / `DispatchOptions` → `HandoffOptions`
- `FunctionToolHookContext` → `ToolExecutionContext`
- `RunResultOutput<T>` → `Output<T>` — canonical output shape shared by `RunResult`, `Session`, `CallResult` (renamed to `SubRunResult` in 0.5.1), `SpawnResult`
- `RunInput` / `BaseInput` → `Input` — canonical input shape with `message`, `tools`, and `state` fields
- `HandlerInput`, `RunOptions`, `TestOptions`, `SimulateOptions` — payload fields grouped under `input` namespace; `HandlerInput.input` uses `Input` directly; `toolInputs` → `input.tools`; `message` widened to `string | MessageInput`
- `RestResponse.output` — uses canonical `Output` type; opt-in `events`, `usage` via `HandlerConfig.response`
- `RestResponse.yieldedTools` — yielded tools promoted to top-level field (replaces `toolCall` / `toolCalls`)
- `session.pendingYieldingCalls` → `session.yieldedTools`; `result.pendingCalls` → `result.yieldedTools`; `pendingCallIds` → `yieldedToolIds`

### Removed

- `result.response` — use `result.output.value` or `result.output.text`
- `result.awaitingInput` — check `result.status === 'yielded_message'`
- `ImageSource`, `AudioSource`, `DocumentSource`, `ImageInput`, `AudioInput` — use `MediaSource` / `MediaPart[]`
- `ResultInput`, `session.input.result()` — use `ToolInput` / `session.input.tool()`
- `CallResultOutput`, `CallOptions`, `SpawnOptions`, `DispatchOptions`, `FunctionToolHookContext`, `ToolHookContext`
- `RunResultOutput` — use `Output`
- `RunInput`, `BaseInput` — use `Input`
- `SessionOutputNamespace` — `session.output` now returns `Output` directly
- `AdkRunConfig` — use `RunOptions`

### Migration from 0.3.x

#### Immutable RenderContext

```typescript
// Before
app.context((ctx) => {
  ctx.events.push(systemEvent)
  ctx.allowedTools = ['search']
  return ctx
})

// After
app.context((ctx) => ({
  ...ctx,
  events: [...ctx.events, systemEvent],
  allowedTools: ['search'],
}))
```

#### Yield statuses

```typescript
// Before
if (result.status === 'yielded') {
  if (result.awaitingInput) {
    /* loop */
  } else {
    /* tool */
  }
}

// After
if (result.status === 'yielded_tool') {
  session.input.tool({ callId: result.yieldedTools[0].callId, input: data })
}
if (result.status === 'yielded_message') {
  session.input.message({ text, invocationId: result.yieldedInvocationId })
}
```

#### Tool input

```typescript
// Before
session.input.tool({ callId, data: value })

// After
session.input.tool({ callId, input: value })
```

#### Media input

```typescript
// Before
session.input.message({ text, images: [{ url }], audio: [{ mimeType, data }] })

// After
session.input.message({
  text,
  media: [
    { type: 'image', source: { type: 'url', url } },
    { type: 'audio', source: { type: 'base64', mimeType, data } },
  ],
})
```

#### Orchestration options

```typescript
// Before (ctx.call renamed to ctx.run in 0.5.1)
ctx.call(agent, { message: 'hello', tempState: { key: 'val' } })

// After (ctx.call renamed to ctx.run in 0.5.1)
ctx.call(agent, { input: { message: 'hello', state: { key: 'val' } } })
```

#### Input / Output types

```typescript
// Before
import type { RunInput, BaseInput, RunResultOutput } from '@animahealth/adk'

const input: RunInput = { message: 'Hello' }
const output: RunResultOutput = result.output

// After
import type { Input, Output } from '@animahealth/adk'

const input: Input = { message: 'Hello' }
const output: Output = result.output
```

#### Handler Input

```typescript
// Before
handler({ sessionId: 'abc', message: 'Hello', state: { mode: 'debug' } })
handler({
  sessionId: 'abc',
  toolInputs: [{ callId: 'c1', data: { ok: true } }],
})

// After
handler({
  sessionId: 'abc',
  input: { message: 'Hello', state: { mode: 'debug' } },
})
handler({
  sessionId: 'abc',
  input: { tools: [{ callId: 'c1', input: { ok: true } }] },
})
```

#### Handler Output

```typescript
// Before
response.output // string
response.toolCall // { callId, name, args }
response.toolCalls // Array<{ callId, name, args }>

// After
response.output.text // string
response.yieldedTools // Array<{ callId, name, args }>
```

#### RunOptions / TestOptions

```typescript
// Before
app.run(agent, { input: 'Hello', state: { mode: 'debug' } })
app.test(agent, { input: 'Start', tools: { ask: [{ answer: 'Blue' }] } })

// After
app.run(agent, { input: { message: 'Hello', state: { mode: 'debug' } } })
app.test(agent, {
  input: { message: 'Start', tools: { ask: [{ answer: 'Blue' }] } },
})
```

`app.run(agent, 'Hello')` string shorthand is unchanged.

#### Yield Renames

```typescript
// Before
session.pendingYieldingCalls
result.pendingCalls
event.pendingCallIds

// After
session.yieldedTools
result.yieldedTools
event.yieldedToolIds
```

## [0.3.1] - 2026-02-07

### Fixed

- Yielding tool `safeParse` failure — feed validation errors back as `tool_result` instead of silently hanging
- Consistent ID prefixes for forked sessions (`session_`) and AG-UI runs (`run_`)

## [0.3.0] - 2026-02-07

Introduces the Hook system, pluggable session persistence, protocol handlers, and deterministic testing — replaces middleware, standalone runners, and user primitives.

### Added

- `Hook` interface — unified observation (`onEvent`, `onStep`) + interception (`before*`/`after*`)
- `app.run()` accepts `RunOptions` with `state` and call-site `hooks`
- `app.test()` — deterministic yield/resume testing (replaces `scriptedUser()`)
- `app.simulate()` — LLM-powered eval loop (replaces `agentUser()`)
- `app.hook.logging()`, `app.hook.metrics()` — built-in hook factories.
- `app.handler.rest()` / `app.handler.agui()` — protocol handlers with `HandlerInput` / `HandlerConfig`
- `SessionStore` interface with `sessionService(store)` factory — pluggable persistence
- Stores: `InMemoryStore` (main entry), `SQLiteStore` (`/stores/sqlite`), `DynamoDBStore` (`/stores/dynamodb`), `PostgresStore` (`/stores/postgres`)
- `runSessionStoreTests()` — shared compliance suite for custom stores
- Scoped shared state via `session.scopes`, `getScopedState()` / `setScopedState()`
- `ConflictError` — thrown on OCC version conflict during `commitSession()`

### Changed

- **`runner.run()` no longer commits sessions** — callers must call `sessionService.commitSession()` (built-in handlers do this automatically)
- `Middleware` / `Hooks` → single `Hook` interface; `onStream` → `onEvent`
- `Agent.middleware` + `Agent.hooks` → `Agent.hooks: Hook[]`; `AdkConfig.middleware` → `AdkConfig.hooks`
- `composeMiddleware()` → `composeHooks()`; `loggingMiddleware()` → `loggingHook()`; `cliMiddleware()` → `cliHook()`
- `session.version` type: `string` → `number`; `SessionStoreSnapshot` → `StoredSession`

### Removed

- `src/users/` — `scriptedUser()`, `humanUser()`, `agentUser()`, `User` interface (use `app.test()` / `app.simulate()`)
- `src/middleware/` — replaced by `src/hook/`
- `InMemorySessionService`, `LocalSessionService` — use `sessionService(new InMemoryStore())`
- Per-scope methods (`getUserState`, etc.) — use `getScopedState` / `setScopedState`
- `HandlerInput.toolInput` — use `toolInputs` array
- `@animahealth/adk/persistence` subpath — use main entry or store subpaths

### Migration from 0.2.x

#### Session Commit (runner.run callers only)

```typescript
// Before
const result = await runner.run(agent, session)

// After
const result = await runner.run(agent, session)
await sessionService.commitSession(session)
```

Built-in handlers and `app.run()` commit automatically — no change needed.

#### Middleware → Hooks

```typescript
// Before
const app = adk({ middleware: [loggingMiddleware()] })
const agent = app.agent({ middleware: [myMw], hooks: { beforeAgent: fn } })

// After
const app = adk({ hooks: [loggingHook()] })
const agent = app.agent({ hooks: [myHook, { beforeAgent: fn }] })
```

#### Session Stores

```typescript
// Before
import { sessionService, SQLiteStore } from '@animahealth/adk'

// After
import { sessionService, InMemoryStore } from '@animahealth/adk'
import { SQLiteStore } from '@animahealth/adk/stores/sqlite'
import { DynamoDBStore } from '@animahealth/adk/stores/dynamodb'
import { PostgresStore } from '@animahealth/adk/stores/postgres'
```

#### User Primitives → app.test / app.simulate

```typescript
// Before
await runner.runWithUser(agent, session, {
  user: scriptedUser({ tools: { approve: [{ ok: true }] } }),
})
await runner.runWithUser(agent, session, {
  user: agentUser({ loop: simAgent, tools: { ask: answerAgent } }),
})

// After
await app.test(agent, { input: 'Start', tools: { approve: [{ ok: true }] } })
await app.simulate(agent, {
  input: 'Start',
  simulator: simAgent,
  tools: { ask: answerAgent },
})
```

## [0.2.1] - 2026-02-06

### Changed

- Ink 3 / React 17 → Ink 5 / React 18 for CLI terminal UI
- CJS→ESM bridge for `app.cli()` — transparent `import()` wrapper so CJS consumers work unchanged
- `extractCurrentThoughtBlock`, `buildInvocationBlocks` → exported from `@animahealth/adk/cli` instead of main entry
- `react`, `ink`, `ink-spinner`, `ink-text-input` — optional peer dependencies for `app.cli()` consumers

### Internal

- `tsup.config.ts` now includes an esbuild plugin that externalizes `../cli` in the CJS build, so `dist/index.js` emits `require("./cli/index.js")` instead of inlining the CLI module tree.
- `scripts/postbuild-cli-cjs-wrapper.cjs` generates a CJS→ESM wrapper at `dist/cli/index.js` that does `import('./index.mjs')` to load Ink in native ESM context.
- `lodash` is force-bundled (`noExternal`) to avoid Node ESM's "Named export not found" error when importing CJS-only packages.
- Jest `moduleNameMapper` mocks added for `ink` and `ink-text-input` since they are ESM-only and cannot be `require()`'d in test.

### Migration from 0.2.0

**CLI utility imports** — if you import `extractCurrentThoughtBlock` or `buildInvocationBlocks`, update the import path:

```typescript
// Before
import { extractCurrentThoughtBlock, buildInvocationBlocks } from '@animahealth/adk'

// After
import { extractCurrentThoughtBlock, buildInvocationBlocks } from '@animahealth/adk/cli'
```

## [0.2.0] - 2026-02-04

Introduces the `adk()` factory — a typed app instance with namespaced methods for agents, tools, context, sessions, and MCP, replacing standalone factories and adding multimodal input/output.

### Added

- `adk()` factory — creates typed app instance with `name` and `schema`
- `app.*` methods for all runnables with automatic type inference
- `app.context.*` namespace for context renderers
- `app.tools.*` namespace for built-in tools:
  - `webSearch()` — web search via Serper API
  - `fetchPage()` — fetches web pages, PDFs, and images as markdown
  - `takeScreenshot()` — captures webpage screenshots
- `app.mcp.*` namespace for MCP server management:
  - `server()` — create/get MCP server instance
  - `tools()` — aggregated callable tools from all servers
  - `toolDefinitions()` — aggregated tool metadata from all servers
  - `resourceDefinitions()` — aggregated resource metadata from all servers
  - `promptDefinitions()` — aggregated prompt metadata from all servers
- `server.*` instance API:
  - `tools()` — callable `FunctionTool[]`
  - `toolDefinitions()` — raw `MCPToolInfo[]`
  - `resourceDefinitions()` — `MCPResourceInfo[]`
  - `promptDefinitions()` — `MCPPromptInfo[]`
  - `resource(uri)` / `prompt(name)` — context renderers
- `session.input.*` namespace for input operations:
  - `message()` — user messages (text and multimodal)
  - `tool()` — user input for yielding tools
- `session.output.*` namespace for output operations:
  - `text` — last assistant text
  - `items` — all assistant events
  - `tool()` — provide tool results (superseded by `session.input.result()` in 0.3.3)
- `result.output.*` namespace with convenient accessors:
  - `text` — last assistant message text
  - `value` — structured output (if schema configured)
  - `items` — all assistant events
  - `media` — generated media (images, audio)
- Multimodal input via `session.input.message({ text, images, audio, media })`
- Multimodal output via `result.output.media` and tool `__media` return pattern
- `MediaPart` type for image, audio, and document attachments
- `ImageInput` and `AudioInput` helpers: `{ url }` or `{ mimeType, data }` (base64)
- Provider support: Claude, OpenAI, and Gemini handle media in user messages and tool results
- `spec.*` namespace for cross-app reusable specs

### Changed

- Standalone factories → `app.*` methods (`agent()` → `app.agent()`, etc.)
- Standalone context renderers → `app.context.*` (`injectSystemMessage()` → `app.context.system()`, etc.)
- Model providers remain standalone: `openai()`, `gemini()`, `claude()`
- Output config simplified: `output: 'key'` instead of `output: output(schema, 'key')`
- State API: method-based → property access
  - Session state is now the default scope: `ctx.state.mode` (not `ctx.state.session.mode`)
  - Other scopes remain explicit: `ctx.state.user.theme`, `ctx.state.patient.id`
- Session input: `addMessage()` → `session.input.message()`
- Session input: `addToolInput()` → `session.input.tool({ callId, data })`
- `UserEvent` structure simplified:
  - `text: string` — always the text message
  - `media?: MediaPart[]` — optional attachments (images, audio)

### Removed

- `BaseRunner` — use `app.run()` instead
- Standalone factories and context renderers — use `app.*` methods
- Method-based state API (`get`, `set`, `delete`, `toObject`)
- `initialState` from `CreateSessionOptions` — use `session.state.update()`
- `session.addMessage()` — use `session.input.message()` instead
- `session.addToolInput()` — use `session.input.tool()` instead
- `session.addToolResult()` — use `session.output.tool()` (superseded by `session.input.result()` in 0.3.3)
- `session.append()` — use `session.pushEvent()` if needed (internal)

### Migration from 0.1.0

#### App Factory Pattern

```typescript
// Before
import { agent, tool, openai, injectSystemMessage, includeHistory, BaseRunner } from '@animahealth/adk';

const myTool = tool({ name: 'greet', schema: z.object({ name: z.string() }), ... });
const assistant = agent({
  name: 'assistant',
  model: openai('gpt-4o-mini'),
  context: [injectSystemMessage('You are helpful'), includeHistory()],
  tools: [myTool],
});
await BaseRunner.run(assistant, 'Hello');

// After
import { adk, openai } from '@animahealth/adk';

const app = adk({ schema: { session: { mode: z.string() } } });

const myTool = app.tool({ name: 'greet', schema: z.object({ name: z.string() }), ... });

const assistant = app.agent({
  name: 'assistant',
  model: openai('gpt-4o-mini'),
  context: [app.context.system('You are helpful'), app.context.history()],
  tools: [myTool],
});

await app.run(assistant, 'Hello');
```

#### State API

```typescript
// Before
ctx.state.get('mode')
ctx.state.set('mode', 'triage')

// After
ctx.state.mode
ctx.state.mode = 'triage'
ctx.state.update({ mode: 'triage', count: 42 })
```

#### Session Input

```typescript
// Before
session.addMessage('Hello')
session.addToolInput(callId, input)

// After
session.input.message('Hello')
session.input.message({ text, invocationId }) // For resuming loops
session.input.tool({ callId, data: input })
```

#### Output Access

```typescript
// Before
const lastEvent = result.session.events.findLast((e) => e.type === 'assistant')
if (lastEvent && lastEvent.type === 'assistant') {
  console.log(lastEvent.text)
}

// After
console.log(result.output.text)

// Structured output
const output = result.output.value

// Provide tool results (superseded by session.input.result() in 0.3.3)
session.output.tool({ callId, result: data })
```

#### Reusable Specs (Advanced)

```typescript
// For runnables shared across multiple apps:
import { spec } from '@animahealth/adk';

// Stateless (no schema)
const calc = spec.tool()({ name: 'calc', schema: z.object({ expr: z.string() }), ... });

// Stateful (with schema constraint)
const counter = spec.tool({ session: { count: z.number() } })({ name: 'inc', ... });

// Bind to any schema compatible app
const boundTool = app.use(calc);
```

## [0.1.0] - 2026-01-21

### Added

- Initial release as a standalone package, extracted from the service it grew inside.

### Migration from the original in-service module

```typescript
// Before
import { agent, tool } from '../../../modules/adk'

// After
import { agent, tool } from '@animahealth/adk'
```

`PersistentSessionService` (DynamoDB) was not part of this extraction and still came from the original service at the time of this release.
