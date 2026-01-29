# @mycontinuum-com/adk - Agent Development Kit

Anima's framework for building production-grade multi-agent AI systems.

## Installation

```bash
npm install @mycontinuum-com/adk

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
  BaseRunner,
  openai,
  injectSystemMessage,
  includeHistory,
} from '@mycontinuum-com/adk';

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
    injectSystemMessage('You are a helpful math assistant. Use the calculator tool for arithmetic.'),
    includeHistory(),
  ],
  tools: [calculator],
});

async function main() {
  const result = await BaseRunner.run(assistant, 'What is 134 divided by 4?');
  console.log(result.session.events);
}

main().catch(console.error);
```

## Core Concepts

### Runnables

The ADK provides five composable primitives:

| Primitive | Purpose |
|-----------|---------|
| `agent()` | LLM-powered reasoning with tools |
| `step()` | Deterministic code execution |
| `sequence()` | Run runnables in order |
| `parallel()` | Run runnables concurrently |
| `loop()` | Iterate until condition met |

### Providers

Swap between LLM providers with one line:

```typescript
import { openai, gemini, claude } from '@mycontinuum-com/adk';

// OpenAI
model: openai('gpt-4o-mini', { temperature: 0.7 })

// Gemini (via AI Studio or Vertex AI)
model: gemini('gemini-2.0-flash', { 
  thinkingConfig: { thinkingBudget: 4096 } 
})

// Claude (via Vertex AI)
model: claude('claude-sonnet-4-5', { 
  project: 'my-project', 
  region: 'europe-west1' 
})
```

### Session & State

Sessions manage conversation history and typed state across scopes:

```typescript
// State scopes
ctx.state.set('key', value);           // session scope (default)
ctx.state.user.set('theme', 'dark');   // persists across user sessions
ctx.state.patient.get('diagnoses');    // persists across patient encounters
ctx.state.temp.set('scratch', data);   // cleared each model step
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
import { InMemorySessionService, LocalSessionService } from '@mycontinuum-com/adk/persistence';

// In-memory (for testing/development)
const memoryService = new InMemorySessionService();

// SQLite-based (for local persistence)
const localService = new LocalSessionService({ 
  dbPath: './sessions.db' 
});
```

For production DynamoDB persistence with OpenSearch, see the implementation in anima-service.

## Testing

```typescript
import { runTest, user, model, setupAdkMatchers } from '@mycontinuum-com/adk/testing';

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

| Example | Description |
|---------|-------------|
| `quickstart.ts` | Minimal agent with calculator tool |
| `assistant.ts` | Interactive chat loop with tools |
| `yieldResume.ts` | Human-in-the-loop approval workflow |
| `reasoning.ts` | Multi-provider reasoning models |
| `dynamicFlow.ts` | Dynamic orchestration (call, spawn, dispatch, transfer) |
| `step.ts` | Steps with routing, gates, and signals |
| `staticFlow.ts` | Full content pipeline (parallel, sequence, loop) |

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
@mycontinuum-com/adk/
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

## Migration from anima-service

If migrating from the embedded `modules/adk` in anima-service:

```typescript
// Before
import { agent, tool } from '../../../modules/adk';

// After  
import { agent, tool } from '@mycontinuum-com/adk';
```

For `PersistentSessionService` (DynamoDB), continue importing from anima-service until that is extracted.

## License

MIT
