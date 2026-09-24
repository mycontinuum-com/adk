# Anima ADK

A TypeScript framework for production multi-agent AI systems — schema-first, event-sourced, and provider-agnostic. Built and used in production at [Anima](https://www.animahealth.com) to run clinical and operational agent workflows.

**Documentation: [adk.animahealth.com](https://adk.animahealth.com)** — runnable docs: every code cell on the site executes this shipped package in your browser.

The ADK is a library, not a platform: no infrastructure dependency beyond a database you choose (or none — the in-memory and SQLite backends need nothing). Every layer is independently useful.

- **One session ledger.** Everything an agent does is an append-only event history; all state derives from it. Time travel, forking, and auditing come for free.
- **Agents that stop and ask.** Tools can yield: the run pauses, the session persists as a row, and a human (or another system) resumes it — minutes or days later.
- **The model sees what you choose.** Context renderers are the only bridge between the ledger and the prompt, so full audit coexists with a small context.
- **Deterministic testing.** The test kit replaces only the model with scripted turns — tools really execute, state really writes — so agent tests run with no API key.
- **Providers behind subpaths.** OpenAI, Gemini, Claude (via Vertex), and EUrouter are optional integrations behind `@animahealth/adk/openai` and friends. Importing the core pulls in none of them.

## Install

```bash
npm install @animahealth/adk
```

Node ≥ 22. `zod` is the one required peer (npm and pnpm install it automatically).
The ADK accepts Zod 3 Classic from 3.25.76 and Zod 4 Classic from 4.6.5; an
existing Zod 3 application does not need to migrate to Zod 4. Optional backends
declare optional peers — install them only for what you use (for example
`better-sqlite3` for the SQLite session store).

## First run — no API key

The real agent loop over a scripted model turn. Tools execute, state writes, the ledger accrues; only the model is played by the script.

```typescript
import { getLastAssistantText, runTest, user, model, mockAgent } from '@animahealth/adk/testing'

const greeter = mockAgent('greeter')
const result = await runTest(greeter, [user('hi'), model('Hello! Ask me anything.')])

console.log(getLastAssistantText(result.events)) // Hello! Ask me anything.
console.log(result.events.map((e) => e.type))
// [ 'user', 'invocation_start', 'model_start', 'assistant', ... ]
```

## Quick start — live

```bash
export OPENAI_API_KEY=sk-...
```

```typescript
import { z } from 'zod'
import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk()

const calculator = app.tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  schema: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: (ctx) => {
    const sanitized = ctx.args.expression.replace(/[^\d\s+\-*/().eE%]/g, '')
    const result = Function(`"use strict"; return (${sanitized})`)()
    return { result }
  },
})

const assistant = app.agent({
  name: 'math_assistant',
  model: openai('gpt-5.6-luna'),
  context: [
    app.context.system(`You are helpful, use the calculator tool for arithmetic.`),
    app.context.history(),
  ],
  tools: [calculator],
})

const result = await app.run(assistant, 'What is 134 divided by 4?')
console.log(result.output.text) // 134 divided by 4 is 33.5.
```

Gemini ships behind `@animahealth/adk/gemini` (AI Studio or Vertex) and Claude behind `@animahealth/adk/claude` (Vertex AI). Provider setup lives in each subpath's typed config.

EUrouter ships behind `@animahealth/adk/eurouter` for hosted models such as DeepSeek, Kimi, and GLM. See the [provider guide](docs/guide/references/providers-memory.md#eurouter) for credentials, routing, and a local example that needs no key.

## Evaluation CLI

Text and voice cases can share one evaluation and one CLI entry point:

```ts
async function main() {
  process.exitCode = await app.evaluate.cli([...textCases, ...voiceCases], {
    concurrency: 4,
  })
}
void main()
```

Call the entry script with `list`, or `run --case <name> --repeat 3 --output ./runs`.
The CLI writes JSON to stdout, diagnostics to stderr, and reports and case evidence to a fresh
run directory. Use silent package scripts when parsing stdout. It exits successfully only
when every selected execution passes. Normal imports still run before the CLI, so keep them quiet.

Use `app.evaluate(cases, options)` for the same mixed suite without command-line handling.
Voice-specific hooks, metrics and room configuration belong in `options.voice`.
See [the mixed voice example](examples/voice-eval.ts).

For native voice with ADK backend tools, [GPT Live voice handler](docs/gpt-live.md) documents `openai.live(...)` with `app.handler.voice(...)`, typed result hooks, and transcript persistence.

## Execution completion and persistence

`app.run()` starts execution immediately. Awaiting it returns its outcome; a run deadline or
`run.abort()` rejects promptly. `run.settled` always fulfills after ADK-owned execution and cleanup
finish and their ledger events are buffered. Use it before committing or closing a session store:

```ts
const run = app.run(assistant, { session, timeout: 30_000 })
try {
  return await run
} finally {
  run.abort()
  await run.settled
  await app.sessions.commit(session)
}
```

Completion is neither success nor durable storage. Admitted tools, their retry chains, inline child
runs and spawned/dispatched work remain owned until they finish. A tool can outlive its own timeout;
the timeout receipt stays authoritative and `settled` waits for the underlying work. A tool or hook
that never finishes can keep `settled` pending. Detached application promises are outside this contract.
Root run cancellation prevents new model/tool admissions after awaited hooks. `ctx.run`'s local
handoff timeout and an agent's duration policy retain their existing behavior; a local handoff timeout
does not itself cancel the child or guarantee its terminal invocation event. Cancel the root run before
draining when stopping the whole operation. Breaking stream iteration cancels it; `handler.turn`
provides the same separate completion barrier, including its persistence work.

## What's in the box

| Entry point | Surface |
| --- | --- |
| `@animahealth/adk` | The app: agents, steps, sequence/parallel/loop, tools, yielding tools, orchestration (`run`/`spawn`/`dispatch`/`transfer`, `app.ask`, `fanout`), context renderers, sessions and typed state scopes, memory, structured output with a forgiving parser, hooks, error handlers, the `turn`/REST/AG-UI handlers, MCP |
| `/openai` · `/gemini` · `/claude` · `/eurouter` | Model provider configs and adapters |
| `/stores/sqlite` · `/stores/postgres` · `/stores/dynamodb` | Durable session stores behind one `SessionStore` contract (in-memory ships in the core) |
| `/voyage` · `/qdrant` | Embedders and served vector backends (`pgvector`, `sqliteVec`, and `inMemoryIndex` ship in the core) |
| `/testing` | The deterministic test kit: `runTest`, `mockAgent`, `MockAdapter`, matchers |
| `/eval` | Evaluation suites, metrics, reports, simulation |
| `/voice` | The LiveKit voice handler and realtime models |
| `/web` | Web tools: search, fetch, screenshot |
| `/agui` · `/cli` | The AG-UI protocol adapter and the interactive terminal UI |

## Stability

The ADK is pre-1.0 and favors one clear API over compatibility aliases. Two tiers:

- **Core** — the main entry and every subpath above. Changes arrive deliberately and are documented in the [CHANGELOG](CHANGELOG.md).
- **Experimental** — `/workflow` (dynamic multi-agent workflows and the Claude-Code-compatible workflow-file loader), `/agents/coding` and `/agents/coding/claude-code` (coding agents over provisioned workspaces), and `/executors` (Docker/Modal workspace executors). Any release may change or remove these without a deprecation cycle; pin your version.

Experimental surfaces are reachable only through their own subpaths, never through the main entry — a build gate enforces it.

## Testing

```bash
pnpm install
pnpm run test
```

The suite runs with no API keys and no database. Every documented session store and vector backend also runs a shared compliance suite against real service containers in [CI](https://github.com/mycontinuum-com/adk/blob/main/.github/workflows/ci.yml) — the contract claims are continuously proven, not asserted.

## Contributing, security, license

This repository is a continuously exported snapshot of the ADK's development home — see [CONTRIBUTING.md](https://github.com/mycontinuum-com/adk/blob/main/CONTRIBUTING.md) for how issues and pull requests flow (short version: issues are the front door, and accepted PRs are imported with your authorship preserved). Report vulnerabilities via [SECURITY.md](https://github.com/mycontinuum-com/adk/blob/main/SECURITY.md), not public issues.

[MIT](LICENSE) © Anima Health.
