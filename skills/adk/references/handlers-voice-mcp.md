# Handlers, Voice, MCP, CLI, And Web

Use this reference for protocol handlers, voice agents, MCP servers, stream events, the interactive CLI, and built-in web tools.

## Handler Model

Handlers are server-agnostic functions. Prefer `app.handler.turn` for custom protocols because it owns the resolve-run-stream-commit lifecycle. `rest`, `agui`, and `voice` add protocol-specific projections on top.

Shared handler config:

- `agent`: required runnable.
- `sessionService`: optional; defaults to the app session service.
- `hooks`: lifecycle hooks; `afterTurn` runs inside the commit boundary.
- `errorHandlers`: recovery handlers.
- `timeout`: run timeout.
- `response`: REST-only response enrichment.

Handler input:

```typescript
{
  sessionId?: string,
  input: {
    message?: string | MessageInput,
    tools?: Array<{ callId: string, input: unknown }>,
    state?: Record<string, unknown>,
    initialState?: StateChanges,
  },
}
```

## Turn

```typescript
const stream = app.handler.turn({ agent })({
  sessionId: 'thread-1',
  input: { message: 'Hello' },
})

for await (const event of stream) {
  // stream events
}

const result = await stream
```

`TurnResult` extends `RunResult` with `sessionId`, `invocationId`, and optional `commitStatus`.

Commit statuses:

- `committed`: first-try commit succeeded.
- `merged`: conflict detected and auto-merge succeeded.
- `skipped`: newer user input superseded this turn.
- `orphaned`: output returned but not persisted.

## REST

`app.handler.rest(config)` returns an async function producing JSON with `sessionId`, `status`, `output`, `yieldedTools`, optional `events`, optional `usage`, optional `state`, `error`, and `warning`.

Use `response: { events: true, usage: true, state: true }` only when the caller needs those fields.

## AG-UI

`app.handler.agui(config)` returns an async iterable of AG-UI SSE events. It maps ADK stream events into AG-UI text, reasoning, tool, state, step, interrupted, and finished events.

For lower-level AG-UI adapter work, see `src/agui/`.

## Voice

`app.handler.voice(config)` creates a LiveKit-based realtime handler. It is lazy-loaded so normal ADK consumers do not need LiveKit peers.

Voice-specific config:

- `setup(participant)`: maps LiveKit participant to `{ sessionId, scopes?, state?, initialState?, recordingKey?, noiseCancellation? }`.
- `timeouts`: handler defaults; agent-level timeouts override after transfers.
- `hooks`: `VoiceHook[]`, including `onEnter`, `onTranscript`, `onVoiceEvent`, `onInactivity`, `onExpiry`, `onDisconnect`.
- `sound`: noise cancellation and background audio options.
- `recording`: local WAV or LiveKit Egress/S3 recording.
- `worker`, `prewarm`, and `name`: LiveKit worker options; `name` defaults to the agent name.

Tools receive `ctx.voice` for voice capabilities such as `say`, `playSound`, `generateReply`, `waitForPlayout`, `interrupt`, and `turnCount`.

`onTranscript` runs in a dedicated queue so it does not block the voice pipeline. Lifecycle hooks return `false` to keep the session alive and `true` to explicitly end; multiple hooks compose so any `false` vetoes ending.

For voice session completion, prefer a `FunctionTool` as `agent.output`; ADK validates, executes, captures output, shuts down, and can auto-trigger the output tool on disconnect/inactivity/expiry once the caller has engaged.

Voice peer dependencies include `@livekit/agents` and a provider plugin such as `@livekit/agents-plugin-openai` or `@livekit/agents-plugin-google`.

## MCP

Create MCP servers through the app namespace:

```typescript
const filesystem = app.mcp.server({
  name: 'filesystem',
  command: 'pnpm',
  args: ['dlx', '@modelcontextprotocol/server-filesystem', '/workspace'],
  cacheToolsList: true,
})

const remote = app.mcp.server({
  name: 'github',
  url: 'https://api.github.com/mcp',
  authorization: process.env.GITHUB_TOKEN,
})
```

Server config supports stdio (`command`, `args`, `env`, `cwd`), HTTP, and SSE (`transport`, `url`, `authorization`, `headers`), plus `timeout`, `cacheToolsList`, `cacheResourcesList`, `cachePromptsList`, `includeTools`, and `excludeTools`.

Use MCP servers as tool sources:

```typescript
tools: [
  filesystem,
  filesystem.only(['read_file', 'list_directory']),
  filesystem.exclude(['delete_file']),
]
```

Resources and prompts can be included in context:

```typescript
filesystem.resource('file:///workspace/README.md')
codeReviewServer.prompt('code-review', { language: 'typescript' })
```

Lifecycle:

- Lazy connect on first tool call.
- Auto reconnect on drops.
- `await app.mcp.connect()` warms all servers.
- `await app.mcp.disconnect()` cleans up all servers.
- Inspect with `app.mcp.servers()`, `app.mcp.get(name)`, `server.getState()`, `server.isConnected()`, `server.healthCheck()`, `app.mcp.tools()`, `app.mcp.toolDefinitions()`, `resourceDefinitions()`, and `promptDefinitions()`.
- Use `server.readResource(uri)` or `server.getPrompt(name, args)` for lower-level MCP access; prefer `server.resource(...)` and `server.prompt(...)` inside agent context.

There is no built-in `confirmTools` option. Wrap risky MCP tools with a normal ADK tool and `yieldSchema` for human confirmation.

MCP support requires optional peer `@modelcontextprotocol/sdk`.

## Stream Events

Common stream events:

- `thought_delta`, `thought`
- `assistant_delta`, `assistant`
- `tool_call`, `tool_yield`, `tool_input`, `tool_result`
- `state_change`
- `invocation_start`, `invocation_end`, `invocation_yield`, `invocation_resume`
- `model_start`, `model_end`
- `artifact_update`

Use `model_start`/`model_end` for observability, context inspection, usage, cost, duration, and provider finish metadata.

## CLI

`app.cli(runnable, inputOrConfig?)` starts the interactive terminal UI. It lazy-loads React/Ink. Display modes are debug, content, and logging.

Use CLI for local development and yield/resume debugging, not production protocol handling.

## Web Tools

`app.tools` includes optional web utilities:

- `app.tools.webSearch(config?)`
- `app.tools.fetchPage(config?)`
- `app.tools.takeScreenshot(config?)`

These are normal `FunctionTool`s and should be included explicitly in `agent.tools`.

Prefer `app.tools.*` for agent-facing web tools. Use `@animahealth/adk/web` only for lower-level providers, fetch pipelines, batch page fetches, and browser screenshot utilities.
