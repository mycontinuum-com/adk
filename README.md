# @animahealth/adk - Agent Development Kit

Anima's framework for building production-grade multi-agent AI systems.

> **Private Package**: This is a private npm package. See [Setup](#setup) for access instructions.

## Setup

This package is published to npm as a **private package** under the `@animahealth` organization. You'll need to configure npm authentication before installing.

### Developer Setup (One-time)

1. **Get an npm read token** from your team lead or create one at [npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens) (requires org membership)

2. **Configure npm** by adding the token to your global `~/.npmrc`:

   ```ini
   //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxx
   ```

   Or set it as an environment variable:

   ```bash
   # Add to your shell profile (~/.zshrc, ~/.bashrc, etc.)
   export NPM_TOKEN=npm_xxxxxxxxxxxx
   ```

   Then create/update `~/.npmrc`:

   ```ini
   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
   ```

3. **Verify access**:

   ```bash
   npm view @animahealth/adk
   ```

### CI Setup (GitHub Actions)

1. **Add the npm token as a repository secret**:
   - Go to your repo → Settings → Secrets and variables → Actions
   - Add a secret named `NPM_TOKEN` with a read-only npm token

2. **Create `.npmrc` in your repo root**:

   ```ini
   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
   ```

3. **Configure your workflow**:

   ```yaml
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4

         - uses: actions/setup-node@v4
           with:
             node-version: '20'
             cache: 'npm'

         - name: Install dependencies
           run: npm ci
           env:
             NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```

### CI Setup (Other Providers)

For CircleCI, GitLab CI, etc., set `NPM_TOKEN` as an environment variable and ensure `.npmrc` references it:

```ini
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

## Installation

Once authenticated, install the package:

```bash
npm install @animahealth/adk

# Install provider SDKs as needed
npm install openai           # For OpenAI models
npm install @google/genai    # For Gemini models
npm install @anthropic-ai/vertex-sdk  # For Claude via Vertex AI
```

## Quick Start

```typescript
import { z } from 'zod';
import {
  agent,
  tool,
  run,
  openai,
  injectSystemMessage,
  includeHistory,
} from '@animahealth/adk';

const calculator = tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  schema: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: (ctx) => {
    const sanitized = ctx.args.expression.replace(/[^\d\s+\-*/().eE%]/g, '');
    const result = Function(`"use strict"; return (${sanitized})`)();
    return { result };
  },
});

const assistant = agent({
  name: 'math_assistant',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(
      'You are a helpful math assistant. Use the calculator tool for arithmetic.',
    ),
    includeHistory(),
  ],
  tools: [calculator],
});

async function main() {
  const result = await run(assistant, 'What is 134 divided by 4?');
  console.log(result.session.events);
}

main().catch(console.error);
```

## Core Concepts

### Runnables

The ADK provides five composable primitives:

| Primitive    | Purpose                          |
| ------------ | -------------------------------- |
| `agent()`    | LLM-powered reasoning with tools |
| `step()`     | Deterministic code execution     |
| `sequence()` | Run runnables in order           |
| `parallel()` | Run runnables concurrently       |
| `loop()`     | Iterate until condition met      |

### Providers

Swap between LLM providers with one line:

```typescript
import { openai, gemini, claude } from '@animahealth/adk';

// OpenAI
model: openai('gpt-4o-mini', { temperature: 0.7 });

// Gemini (via AI Studio or Vertex AI)
model: gemini('gemini-2.5-flash', {
  thinkingConfig: { thinkingBudget: 4096 },
});

// Claude (via Vertex AI)
model: claude('claude-sonnet-4-5', {
  project: 'my-project',
  region: 'europe-west1',
});
```

### Session & State

Sessions manage conversation history and typed state across scopes:

```typescript
import { session, run } from '@animahealth/adk';

// Create a session
const s = await session('my-app', { userId: 'user-123' });

// Set state before running
s.state.update({
  session: { mode: 'triage' },
  user: { preferences: { theme: 'dark' } },
});
// or
s.state.session.set('mode', 'dark');

// Run with the session
const result = await run(myAgent, { session: s, input: 'Hello!' });

// State scopes in tool/hook contexts
ctx.state.set('key', value); // session scope (default)
ctx.state.user.set('theme', 'dark'); // persists across user sessions
ctx.state.patient.get('diagnoses'); // persists across patient encounters
ctx.state.temp.set('scratch', data); // cleared each model step
```

### Human-in-the-Loop

Tools can yield for user approval:

```typescript
const approval = tool({
  name: 'request_approval',
  schema: z.object({ action: z.string() }),
  yieldSchema: z.object({ approved: z.boolean() }),
  execute: (ctx) => {
    if (!ctx.input?.approved) return { status: 'declined' };
    return performAction(ctx.args.action);
  },
});
```

## Session Persistence

The package includes two built-in session services:

```typescript
import {
  session,
  InMemorySessionService,
  LocalSessionService,
} from '@animahealth/adk';

// In-memory (default, for testing/development)
const s = await session('my-app');

// With explicit service
const memoryService = new InMemorySessionService();
const s = await session('my-app', { sessionService: memoryService });

// SQLite-based (for local persistence)
const localService = new LocalSessionService('./sessions.db');
const s = await session('my-app', { sessionService: localService });
```

For production DynamoDB persistence with OpenSearch, see the implementation in anima-service.

## Testing

```typescript
import {
  runTest,
  user,
  model,
  setupAdkMatchers,
} from '@animahealth/adk/testing';

setupAdkMatchers();

test('agent handles calculation', async () => {
  const { session, status } = await runTest(myAgent, [
    user('Calculate 2 + 2'),
    model({ toolCalls: [{ name: 'calculate', args: { expr: '2+2' } }] }),
    model({ text: 'The answer is 4' }),
  ]);

  expect(status).toBe('completed');
  expect(session.events).toHaveToolCall('calculate');
});
```

## Documentation

For comprehensive documentation, see:

- **[DEVELOPER-README.md](./src/DEVELOPER-README.md)** - Full API reference and patterns
- **[examples/](./examples/)** - Standalone pattern examples

## Examples

The package includes standalone examples demonstrating core patterns:

| Example          | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `quickstart.ts`  | Minimal agent with calculator tool                      |
| `assistant.ts`   | Interactive chat loop with tools                        |
| `yieldResume.ts` | Human-in-the-loop approval workflow                     |
| `reasoning.ts`   | Multi-provider reasoning models                         |
| `step.ts`        | Steps with routing, gates, and signals                  |
| `staticFlow.ts`  | Full content pipeline (parallel, sequence, loop)        |
| `dynamicFlow.ts` | Dynamic orchestration (call, spawn, dispatch, transfer) |

Run examples:

```bash
npx tsx examples/quickstart.ts
npx tsx examples/assistant.ts
```

### Additional Examples in anima-service

For production-style examples with Anima-specific integrations, see anima-service:

- `scripts/adk/examples/clinician/` - Multi-agent clinical triage system
- `scripts/adk/examples/document-researcher/` - Research assistant with sub-agent analysis
- `scripts/adk/examples/request-researcher/` - Request dataset analysis

## Architecture

```
@animahealth/adk/
├── agents/      # Runnable factories (agent, step, sequence, parallel, loop)
├── core/        # Runner, tools, orchestration primitives
├── context/     # Render pipeline for model context
├── providers/   # LLM adapters (OpenAI, Gemini, Claude)
├── session/     # Event ledger, state management
├── middleware/  # Cross-cutting concerns (logging, streaming)
├── errors/      # Error handling and recovery
├── testing/     # Mocks, matchers, test utilities
├── cli/         # Interactive terminal UI
└── persistence/ # Session storage interfaces
```

## Publishing (Maintainers)

To publish a new version:

1. **Update version** in `package.json`

2. **Build and test**:

   ```bash
   npm run build
   npm test
   ```

3. **Publish** (requires npm org write access + 2FA):

   ```bash
   npm publish
   ```

   If using an automation token with 2FA bypass:

   ```bash
   npm publish --//registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxx
   ```

4. **Tag the release**:

   ```bash
   git tag v0.x.x
   git push origin v0.x.x
   ```

## Security

- **Never commit npm tokens** to the repository
- Use **read-only tokens** for CI and developer access
- Use **write tokens** only for publishing, with limited scope to `@animahealth/adk`
- Rotate tokens periodically via [npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens)

## License

MIT - Anima Health Internal Use
