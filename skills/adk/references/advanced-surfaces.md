# Advanced Surfaces

Use this reference for package exports, artifacts, executors, coding agents, knowledge, parsers, gateways/process stores, AG-UI adapter internals, and package layout.

## Export Hygiene

Before documenting or consuming an ADK API, verify it is exported from:

- `src/index.ts`
- `package.json` `exports`
- the relevant module `src/**/index.ts`

Optional peer dependency surfaces should generally be subpath exports so consumers do not install unrelated SDKs.

Current subpath exports include:

- `@animahealth/adk/cli`
- `@animahealth/adk/testing`
- `@animahealth/adk/eval`
- `@animahealth/adk/web`
- `@animahealth/adk/agui`
- `@animahealth/adk/stores/dynamodb`
- `@animahealth/adk/stores/postgres`
- `@animahealth/adk/voice`
- `@animahealth/adk/openai`
- `@animahealth/adk/gemini`
- `@animahealth/adk/claude`
- `@animahealth/adk/voyage`
- `@animahealth/adk/qdrant`
- `@animahealth/adk/executors`
- `@animahealth/adk/agents/coding`
- `@animahealth/adk/agents/coding/claude-code`

## Artifacts

Artifacts support versioned binary/text outputs associated with agent work.

Main exports include:

- `InMemoryArtifactService`
- `postgresArtifactService`
- `PostgresArtifactService`
- `inferMimeType`
- `createArtifactsProxy`
- `createNoopArtifactsProxy`
- artifact types such as `ArtifactService`, `Artifact`, `ArtifactSummary`, `ArtifactVersion`, `SaveArtifactOptions`, `SaveArtifactResult`, `LoadArtifactOptions`, and `PostgresArtifactServiceConfig`.

Use artifact services when outputs need durable storage/versioning instead of being embedded in session state. For local eval packages, filesystem files can be reviewer exports, but the session event ledger plus artifact updates should remain the provenance source.

## Executors

Executor modules support running work outside the current process and synchronizing files/artifacts. Check `src/executors/` before changing executor contracts.

Public executor subpath: `@animahealth/adk/executors`.

Important exports:

- `createDockerExecutor`, `DockerExecutor`
- `createModalExecutor`, `ModalExecutor`
- `workspaceTools`, `DEFAULT_BLOCKED_COMMANDS`
- `createArtifactSync`, `BatchArtifactSync`, `NoopArtifactSync`
- `createFileWatchSync`, `FileWatchArtifactSync`
- `createModalClient`, `MockModalClient`

Use `workspaceTools({ sandboxed: true })` only inside Docker/Modal-style isolation. When not sandboxed, mutating tools are approval-marked.

## Coding Agents

Coding-agent surfaces live under:

- `src/agents/coding/`
- `src/agents/coding/claude-code/`

Public subpaths:

- `@animahealth/adk/agents/coding`
- `@animahealth/adk/agents/coding/claude-code`

Use these for agentic code execution integrations instead of inventing parallel runner abstractions.

```typescript
import { claudeCode, coding } from '@animahealth/adk'

const coder = claudeCode({
  workspace,
  config: { permissionMode: 'acceptEdits' },
})

const handle = coder.run('Fix the failing test')
const result = await handle

const tool = coder.asTool({ name: 'coder', description: 'Modify code in the workspace.' })
const mock = coding.mock({ responses: [{ type: 'assistant', text: 'Done' }] })
const noop = coding.noop()
```

Use real coding agents only where external coding tools are the intended execution engine; use `coding.mock` or `coding.noop` in tests.

## Knowledge

Knowledge-layer exports support Fab provisioning into harness-native files:

- `provisionClaudeProtocol`
- `renderClaudeMd`
- `renderRule`
- `renderSettings`
- types such as `ProvisioningItem`, `ProvisionManifest`, `KnowledgeEntry`, `ProvisionOptions`, and `ClaudeSettings`.

Use the knowledge layer for adapter-controlled provisioning of instructions, rules, skills, settings, and working artifacts. Do not hand-roll `.claude/` or `.artifacts/` layout logic in parallel.

## Parser

Parser exports from the main entry include:

- `parse`, `parsePartial`, `createParser`
- `parseJsonish`, `parsePartialJson`, `extractJsonFromText`
- `coerce`, `coercePartial`
- `createStreamParser`, `parseStreamChunks`

Use structured agent `output` schemas first. Use parser/coercion utilities for structured model output repair and streaming parse cases instead of ad hoc JSON string handling. Do not use regex/string slicing to recover JSON from model text.

Import parser utilities from the main entry; no `@animahealth/adk/parser` subpath is currently exported.

## Gateway And Process Stores

Gateway/process storage is distinct from session storage. Main exports include:

- `createGateway`, `GatewayImpl`
- `createInProcessExecutor`, `InProcessExecutor`
- `inMemoryProcessStore`, `InMemoryProcessStore`
- `postgresProcessStore`, `PostgresProcessStore`

Use gateway abstractions for dispatch/send/subscribe process workflows rather than overloading `SessionStore`.

Gateway operations include `dispatch`, `send`, `subscribe`, `status`, `stop`, `start`, `shutdown`, `listWorkspaceFiles`, and `injectEvent`.

## AG-UI Adapter

The protocol handler `app.handler.agui` is the normal public surface. Use `@animahealth/adk/agui` and `src/agui/` only when working on adapter internals or custom AG-UI integration.

There is a local design doc at `src/agui/DESIGN.md`.

## Package Layout

Current source layout:

```text
src/
  agents/       # runnable factories, patterns, coding agents
  agui/         # AG-UI adapter internals
  api/          # adk() app namespace and spec factories
  artifacts/    # artifact services
  channels/     # event channels
  cli/          # interactive terminal UI
  context/      # render pipeline and prompt helpers
  core/         # runner, tools, orchestration
  errors/       # handlers and pipeline
  eval/         # evals, metrics, reports, voice eval
  executors/    # Docker/Modal/workspace execution
  gateway/      # process gateway and stores
  handler/      # turn, REST, AG-UI
  hook/         # lifecycle hooks
  integrations/ # provider integration helpers
  knowledge/    # Fab knowledge provisioning helpers
  mcp/          # MCP client/server manager
  memory/       # vector memory and providers
  parser/       # parsing and coercion
  providers/    # model adapters
  run/          # test/simulate named execution patterns
  session/      # event ledger and stores
  testing/      # mocks/matchers/test runner
  types/        # public/internal types
  voice/        # LiveKit voice runtime
  web/          # web tools
```

## Maintainer Checks

For package API changes:

1. Update source and tests.
2. Update `src/index.ts` and `package.json` exports together when adding public surfaces.
3. Run `pnpm run typecheck`.
4. Run targeted `pnpm run test -- <pattern>`.
5. Run `pnpm run build` when export or packaging behavior changes.
