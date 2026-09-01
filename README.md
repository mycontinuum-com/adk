# Anima ADK

A TypeScript framework for production multi-agent AI systems — schema-first, event-sourced, and provider-agnostic. Built and used in production at [Anima](https://www.animahealth.com) to run clinical and operational agent workflows.

The ADK is a library, not a platform: no infrastructure dependency beyond a database you choose (or none — the in-memory and SQLite backends need nothing). Every layer is independently useful.

- **One session ledger.** Everything an agent does is an append-only event history; all state derives from it. Time travel, forking, and auditing come for free.
- **Agents that stop and ask.** Tools can yield: the run pauses, the session persists as a row, and a human (or another system) resumes it — minutes or days later.
- **The model sees what you choose.** Context renderers are the only bridge between the ledger and the prompt, so full audit coexists with a small context.
- **Deterministic testing.** The test kit replaces only the model with scripted turns — tools really execute, state really writes — so agent tests run with no API key.
- **Providers behind subpaths.** OpenAI, Gemini, and Claude (via Vertex) are optional peers behind `@animahealth/adk/openai` and friends. Importing the core pulls in none of them.

## Install

```bash
npm install @animahealth/adk
```

Node ≥ 22. `zod` is the one required peer (npm and pnpm install it automatically). Optional backends declare optional peers — install them only for what you use (for example `better-sqlite3` for the SQLite session store).

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

## What's in the box

| Entry point | Surface |
| --- | --- |
| `@animahealth/adk` | The app: agents, steps, sequence/parallel/loop, tools, yielding tools, orchestration (`run`/`spawn`/`dispatch`/`transfer`, `app.ask`, `fanout`), context renderers, sessions and typed state scopes, memory, structured output with a forgiving parser, hooks, error handlers, the `turn`/REST/AG-UI handlers, MCP |
| `/openai` · `/gemini` · `/claude` | Model provider configs and adapters |
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

The suite runs with no API keys and no database. Every documented session store and vector backend also runs a shared compliance suite against real service containers in [CI](.github/workflows/ci.yml) — the contract claims are continuously proven, not asserted.

## Contributing, security, license

This repository is a continuously exported snapshot of the ADK's development home — see [CONTRIBUTING.md](CONTRIBUTING.md) for how issues and pull requests flow (short version: issues are the front door, and accepted PRs are imported with your authorship preserved). Report vulnerabilities via [SECURITY.md](SECURITY.md), not public issues.

[MIT](LICENSE) © Anima Health.
