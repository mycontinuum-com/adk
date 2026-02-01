# Agent Development Kit (ADK)

Anima's framework for building production-grade multi-agent AI systems.

## Quick Start

Set your API key for the provider you want to use:

```bash
# OpenAI (EU or US)
export OPENAI_EU_API_KEY=sk-...
export OPENAI_API_KEY=sk-...

# Gemini (AI Studio)
export GEMINI_API_KEY=...

# Vertex AI (Gemini or Claude)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
```

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
  model: openai('gpt-5-mini'),
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

## Blending Code and AI

The `Step` primitive integrates deterministic logic with AI reasoning—data loading, routing, validation, and orchestration:

```typescript
const pipeline = sequence({
  name: 'support',
  runnables: [
    step({
      name: 'load',
      execute: (ctx) => {
        ctx.state.ticket = fetchTicket();
      },
    }),
    step({
      name: 'route',
      execute: (ctx) =>
        ctx.state.ticket?.priority === 'urgent'
          ? urgentAgent
          : standardAgent,
    }),
    step({ name: 'log', execute: recordMetrics }),
  ],
});
```

## Philosophy

1. **Composable Primitives**: Five building blocks—`Agent`, `Step`, `Sequence`, `Parallel`, `Loop`—compose freely and nest to any depth. Structural composition combines with dynamic orchestration (`call`, `spawn`, `dispatch`, `transfer`) to enable arbitrary workflow topologies.

2. **Event-Sourced State**: All session state derives from an append-only event ledger. A single session contains all events from all agents, tagged with `invocationId` to track origin while maintaining complete visibility.

3. **Decoupled Context Rendering**: The session ledger is separated from model context by composed renderers. This allows precise control over what each agent sees.

4. **Provider Agnostic**: Agents are defined independently of their LLM provider. Swap between OpenAI and Gemini with a single line change.

5. **Serverless-First**: The yield/resume pattern enables human-in-the-loop workflows across Lambda invocations without long-running processes.

6. **Transparent Execution**: Every model call is fully observable—see exactly what context was sent, what response was received, token usage, and estimated cost.

7. **Testability by Design**: First-class mocking, declarative test scenarios, and full event introspection make agent behavior verifiable and reproducible.

## Examples

### Pattern Examples

The `scripts/adk/examples/` directory contains focused examples demonstrating individual ADK patterns:

| Example                | Demonstrates                                       |
| ---------------------- | -------------------------------------------------- |
| `assistant.ts`         | Conversational chat loop with tools                |
| `reasoning.ts`         | OpenAI, Gemini, and Claude reasoning models        |
| `staticFlow.ts`        | Orchestration with parallel, sequence, loop        |
| `dynamicFlow.ts`       | Orchestration with call, spawn, dispatch, transfer |
| `fanout.ts`            | Parallel (spawn) vs sequential (call) fanout       |
| `spawnDispatch.ts`     | Spawn (awaitable) vs dispatch (fire-and-forget)    |
| `yieldResume.ts`       | Human-in-the-loop approval workflow                |
| `scopedState.ts`       | Multi-scope state management                       |
| `step.ts`              | Steps with routing, signals, gates, and pipelines  |
| `stepOrchestration.ts` | Using ctx.call within steps for multi-agent flows  |
| `retry.ts`             | Tool-level retry with exponential backoff          |

Run any example with:

```bash
npx tsx scripts/adk/examples/<example>.ts
```

### Clinician

The `scripts/adk/examples/clinician/` directory demonstrates a production-style multi-agent clinical triage system with policy-driven questioning.

```bash
npx tsx scripts/adk/examples/clinician/main.ts
```

### Request Researcher

Research assistant for analyzing patient request datasets (~180k requests).

```bash
# Download dataset: https://eu-west-2.console.aws.amazon.com/s3/object/anima-product-research-data?region=eu-west-2&prefix=5e13685a-390e-4ec3-a7ed-e9b43bb95ae5.zip
# Unzip to data/request-research/
npx tsx scripts/adk/examples/request-researcher/main.ts <folderDatasetId>
```

### Document Researcher

Research assistant for analyzing medical documents via live production indexes (OpenSearch, Qdrant).

```bash
npx tsx scripts/adk/examples/document-researcher/main.ts
```

## Interactive CLI

The ADK includes an interactive terminal UI for developing and testing agents. It provides real-time event visualization, navigation through the event trace, log capture, and automatic handling of yield/resume flows.

```typescript
import { cli } from '@animahealth/adk';

cli(myAgent, 'Hello!');
```

The CLI offers three display modes, switchable via keyboard:

| Mode        | Key | Description                                                       |
| ----------- | --- | ----------------------------------------------------------------- |
| **Debug**   | `d` | Full trace with model context blocks, tools, state changes        |
| **Content** | `c` | Clean view showing only user/assistant/thought/tool_call events   |
| **Logging** | `l` | View captured console logs, Pino JSON output, and platform logger |

## Runnables

Runnables are the building blocks of ADK workflows. There are six types:

### Agent

An LLM-powered reasoning agent that can use tools and maintain conversation context.

```typescript
const myAgent = agent({
  name: 'assistant',
  model: openai('gpt-4o-mini'),
  context: [injectSystemMessage('...'), includeHistory()],
  tools: [myTool],
});
```

| Option          | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `description`   | Agent description (used by orchestrating agents)                  |
| `output`        | State key or schema for structured output                         |
| `toolChoice`    | `'auto'` \| `'none'` \| `'required'` \| `{ name: 'tool_name' }`   |
| `maxSteps`      | Maximum reasoning steps (default: 25)                             |
| `hooks`         | Lifecycle hooks: `beforeAgent`, `afterAgent`, `beforeModel`, etc. |
| `middleware`    | Agent-level middleware                                            |
| `errorHandlers` | Agent-level error handlers                                        |

### Step

Execute TypeScript code as part of a workflow. Steps can execute side effects, return signals, or return a runnable to delegate to.

```typescript
const fetchStep = step({
  name: 'fetch_data',
  execute: async (ctx) => {
    ctx.state.data = await fetchFromApi('/data');
  },
});

const router = step({
  name: 'router',
  execute: (ctx) => {
    if (ctx.state.priority === 'urgent') return urgentHandler;
    if (!ctx.state.authenticated) return ctx.fail('Not authenticated');
    if (ctx.state.cached) return ctx.complete(ctx.state.cached, 'result');
    return standardHandler;
  },
});

const pipeline = sequence({
  name: 'pipeline',
  runnables: [fetchStep, router, processingAgent],
});
```

| Signal / Return      | Behavior                            |
| -------------------- | ----------------------------------- |
| `void`               | Continue to next step               |
| `ctx.skip()`         | Complete silently, no output        |
| `ctx.respond(text)`  | Emit assistant message, complete    |
| `ctx.fail(message)`  | Complete with error status          |
| `ctx.complete(v, k)` | Set state value, complete           |
| `return runnable`    | Delegate execution to that runnable |

`StepContext` also provides `invocationId`, `session`, `state`, and orchestration methods (`call`, `spawn`, `dispatch`, `transfer`).

### Sequence

Execute runnables in order, passing the same session context through each step.

```typescript
const pipeline = sequence({
  name: 'pipeline',
  runnables: [analyzerAgent, summarizerAgent, formatterAgent],
});
```

### Parallel

Run runnables concurrently on cloned sessions, then merge events back deterministically.

```typescript
const fanout = parallel({
  name: 'fanout',
  runnables: [factChecker, sentimentAnalyzer, summarizer],
  failFast: false,
  branchTimeout: 30000,
  minSuccessful: 2,
  merge: (ctx) => {
    return [
      /* custom merge logic */
    ];
  },
});
```

### Loop

Iterate a runnable until a condition is met or max iterations reached.

```typescript
const chat = loop({
  name: 'chat',
  runnable: assistant,
  maxIterations: 100,
  yields: true,
  while: (ctx) => !ctx.state.completed,
});
```

| Option          | Description                                    |
| --------------- | ---------------------------------------------- |
| `maxIterations` | Maximum loop iterations                        |
| `yields`        | Pause between iterations for user input        |
| `while`         | Condition function - loop continues while true |

## Models

The ADK supports multiple providers with provider-specific configurations:

```typescript
openai('gpt-5-mini', { temperature: 0.7, reasoning: { effort: 'low' } });
gemini('gemini-3-flash-preview', { thinkingConfig: { thinkingBudget: 4096 } });
// google-vertex
gemini('gemini-3-flash-preview', {
  thinkingConfig: { thinkingBudget: 4096 },
  project: 'my-project',
  region: 'europe-west1',
});
claude('claude-sonnet-4-5', { project: 'my-project', region: 'europe-west1' });
```

| Provider | Option                           | Description                                         |
| -------- | -------------------------------- | --------------------------------------------------- |
| All      | `temperature`                    | Sampling temperature                                |
| All      | `maxTokens`                      | Maximum tokens in response                          |
| All      | `retry`                          | Retry config: `maxAttempts`, `backoffMultiplier`    |
| OpenAI   | `reasoning.effort`               | Reasoning for o-series: `low` \| `medium` \| `high` |
| Gemini   | `thinkingConfig.thinkingBudget`  | Token budget for thinking (e.g. `4096`)             |
| Gemini   | `thinkingConfig.thinkingLevel`   | `minimal` \| `low` \| `medium` \| `high`            |
| Gemini   | `thinkingConfig.includeThoughts` | Include reasoning in events                         |
| Gemini   | `vertex`                         | Vertex AI config: `{ project, location }`           |
| Claude   | `thinking.budgetTokens`          | Token budget for extended thinking                  |
| Claude   | `vertex`                         | Required: `{ project, region }`                     |

### Authentication

#### OpenAI

Set one of these environment variables:

| Variable                | Description                 |
| ----------------------- | --------------------------- |
| `OPENAI_API_KEY`        | Standard OpenAI API key     |
| `OPENAI_EU_API_KEY`     | OpenAI EU region key (GDPR) |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint URL   |
| `AZURE_OPENAI_API_KEY`  | Azure OpenAI API key        |

Endpoints are tried in order: Azure → EU → Standard.

#### Gemini (AI Studio)

```bash
export GEMINI_API_KEY=...
```

Or pass directly to the adapter:

```typescript
import { runner, GeminiAdapter } from '@animahealth/adk';

const r = runner({
  adapters: { gemini: new GeminiAdapter('your-api-key') },
});
```

#### Gemini & Claude (Vertex AI)

Both Gemini and Claude support Google Cloud Vertex AI. Authentication options:

**Option 1: Environment variable**

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
```

**Option 2: Pass credentials in model config (recommended)**

```typescript
gemini('gemini-3-flash-preview', {
  vertex: {
    project: 'anima-product',
    location: 'europe-west1',
    credentials: '/path/to/credentials.json',
  },
});

claude('claude-sonnet-4-5', {
  vertex: {
    project: 'anima-product',
    location: 'europe-west1',
    credentials: '/path/to/credentials.json',
  },
});
```

The credentials file should be a service account JSON key from Google Cloud Console.

### OpenAI Multi-Endpoint Configuration

The OpenAI adapter supports multiple endpoints with automatic fallback:

```typescript
const adapter = new OpenAIAdapter([
  { type: 'azure', baseUrl: process.env.AZURE_OPENAI_ENDPOINT },
  { type: 'openai', baseUrl: 'https://eu.api.openai.com/v1' },
  { type: 'openai' },
]);
```

| Variable                   | Purpose                                     |
| -------------------------- | ------------------------------------------- |
| `AZURE_OPENAI_API_VERSION` | API version (default: `2025-01-01-preview`) |

Model names are automatically mapped between logical names and deployment-specific versions.

### Gemini via Vertex AI

Use Gemini models through Google Cloud Vertex AI instead of AI Studio:

```typescript
gemini('gemini-3-flash-preview', {
  thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
  vertex: {
    project: 'anima-product',
    location: 'europe-west1',
    credentials: process.env.GCP_CREDENTIALS_PATH,
  },
});
```

### Claude via Vertex AI

Claude models are available through Google Cloud Vertex AI:

```typescript
claude('claude-sonnet-4-5', {
  project: 'anima-product',
  region: 'europe-west1',
  credentials: process.env.GCP_CREDENTIALS_PATH,
});

claude(
  'claude-sonnet-4-5',
  {
    project: 'anima-product',
    region: 'europe-west1',
  },
  {
    thinking: { budgetTokens: 4096 },
  },
);
```

Requirements:

- Enable Claude models in Google Cloud Model Garden
- IAM permissions for Vertex AI (`roles/aiplatform.user`)

## Tools

Tools extend agent capabilities with type-safe schemas and session context access.

```typescript
const calculator = tool({
  name: 'calculate',
  description: 'Evaluate a math expression',
  schema: z.object({ expr: z.string().describe('Expression to evaluate') }),
  execute: (ctx) => {
    ctx.state.lastCalculation = ctx.args.expr;
    return { result: Function(`"use strict"; return (${ctx.args.expr})`)() };
  },
});
```

| Option        | Description                                                        |
| ------------- | ------------------------------------------------------------------ |
| `timeout`     | Execution timeout in ms                                            |
| `retry`       | Retry config: `maxAttempts`, `initialDelayMs`, `backoffMultiplier` |
| `yieldSchema` | Zod schema for external input (triggers human-in-the-loop)         |
| `prepare`     | Transform args before execute                                      |
| `finalize`    | Post-process result after execute                                  |

### Yielding Tools

Tools with `yieldSchema` pause execution for typed external input. The behavior depends on whether `execute` is provided:

**Gating Tool** (no execute) - Yields for user to provide result:

```typescript
const ask = tool({
  name: 'ask',
  description: 'Ask user a question',
  schema: z.object({ question: z.string() }),
  yieldSchema: z.object({ answer: z.string() }),
  finalize: (ctx) => ({
    question: ctx.args.question,
    answer: ctx.input!.answer,
  }),
});
```

**Confirming Tool** (with execute) - Execute runs AFTER user confirms:

```typescript
const approval = tool({
  name: 'request_approval',
  description: 'Request approval before performing action',
  schema: z.object({ action: z.string() }),
  yieldSchema: z.object({ approved: z.boolean() }),
  execute: (ctx) => {
    if (!ctx.input?.approved) return { status: 'declined' };
    return performAction(ctx.args.action);
  },
});
```

The lifecycle for yielding tools is:

1. `prepare` (if provided) - transform args, stored in `ToolYieldEvent`
2. **YIELD** - pause for external input via `session.addToolInput(callId, input)`
3. `execute` (if provided) - runs with `ctx.input` available
4. `finalize` (if provided) - post-process with `ctx.args`, `ctx.input`, and `ctx.result`

Input is provided via `session.addToolInput(callId, input)`. The input is validated against `yieldSchema` on resume.

### Agent Orchestration

The ADK provides orchestration primitives for agent-to-agent communication:

```typescript
const specialist = agent({ name: 'specialist', model: openai('gpt-4o-mini'), ... });

const orchestrate = tool({
  name: 'orchestrate',
  schema: z.object({ task: z.string(), mode: z.string() }),
  execute: async (ctx) => {
    const { task, mode } = ctx.args;
    switch (mode) {
      case 'call':
        const result = await ctx.call(specialist, { message: task });
        return result.output;

      case 'spawn':
        const handle = ctx.spawn(specialist, { message: task });
        return { taskId: handle.invocationId };

      case 'dispatch':
        ctx.dispatch(specialist, { message: task });
        return { status: 'dispatched' };

      case 'transfer':
        ctx.state.set('handoffContext', { task });
        return specialist;
    }
  },
});
```

| Primitive  | Behavior                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| `call`     | Synchronous - await result, sub-agent events visible in ledger               |
| `spawn`    | Async handle - `handle.wait()` to await, `handle.abort()` to cancel          |
| `dispatch` | Fire-and-forget - no waiting, errors logged but not retrievable              |
| `transfer` | Return a `Runnable` to handoff - original exits with `status: 'transferred'` |

**Transfers** are triggered by returning a `Runnable` from a tool's execute function or from agent hooks (`beforeAgent`, `beforeModel`, `afterModel`). To pass context to the target agent, set state before returning:

```typescript
ctx.state.handoffContext = { reason: 'escalation', data: ... };
return targetAgent;
```

The `call`, `spawn`, and `dispatch` methods are available on `ToolContext` and `StepContext`.

## Context Renderers

Context renderers are the bridge between the session's event ledger and what the model actually sees. This decoupling is fundamental to the ADK's architecture:

```
Session Events (source of truth)    →    Context Renderers    →    Model Context
[user, assistant, tool_call, ...]        [transform/filter]        [curated view]
```

The rendering pipeline works as follows:

1. `buildContext()` creates an empty `RenderContext` with `events: []`
2. Each renderer in the agent's `context` array transforms the `RenderContext`
3. Renderers can add events (e.g., `injectSystemMessage`), include session events (e.g., `includeHistory`), or filter events (e.g., `selectRecentEvents`)
4. The final `RenderContext.events` is serialized and sent to the model

This separation enables:

- **Full audit trails** while limiting what the model sees
- **Synthetic events** (like system instructions) that don't persist to the session
- **Different views** for different agents via scope filtering
- **Token management** without losing history

### Basic Renderers

```typescript
injectSystemMessage('You are a helpful assistant.');
wrapUserMessages((message) => `<user>\n${message}\n</user>`);
```

### Typed Prompts

For type-safe state access in prompts, use the `message()` and `enrichment()` factories:

```typescript
import {
  message,
  enrichment,
  injectSystemMessage,
  enrichUserMessages,
} from '@animahealth/adk';

const stateSchema = {
  session: { analysis: analysisSchema },
} satisfies StateSchema;

// MessagePrompt - creates new messages (system or user)
const dynamicInstruction = message(stateSchema, (ctx) => {
  return `Analysis: ${ctx.state.analysis?.result ?? 'none'}`;
});

// EnrichmentPrompt - transforms existing user messages
const contextEnricher = enrichment(stateSchema, (ctx) => {
  return `[Context: ${ctx.state.analysis?.summary}]\n${ctx.message}`;
});

const myAgent = agent({
  context: [
    injectSystemMessage('You are a helpful assistant.'), // Static string
    injectSystemMessage(dynamicInstruction), // Typed prompt → SystemEvent
    includeHistory(),
    enrichUserMessages(contextEnricher, { targetAgent: 'my_agent' }),
  ],
});
```

| Prompt Type        | Render Context               | Purpose                            |
| ------------------ | ---------------------------- | ---------------------------------- |
| `MessagePrompt`    | `{ state, schema }`          | Create new events (system or user) |
| `EnrichmentPrompt` | `{ state, schema, message }` | Transform existing user messages   |

The same `MessagePrompt` can be injected as either a system message (`injectSystemMessage`) or user message (`injectUserMessage`).

### History & Filters

```typescript
const myAgent = agent({
  context: [
    injectSystemMessage('...'),
    includeHistory({ scope: 'ancestors' }),
    pruneReasoning(),
    selectRecentEvents(20),
  ],
});
```

### Tool Control

Control which tools are available and whether the model must use them:

```typescript
const myAgent = agent({
  context: [
    injectSystemMessage('...'),
    includeHistory(),
    limitTools(['approve', 'reject']),
    setToolChoice('required'),
  ],
});
```

| Renderer                    | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `limitTools(['a', 'b'])`    | Restrict available tools                                        |
| `setToolChoice('required')` | Force tool usage (`'auto'`, `'none'`, `'required'`, `{ name }`) |

## Session & State

### Creating Sessions

Sessions manage the event ledger and provide typed state access:

```typescript
import { z } from 'zod';
import { session, type StateSchema } from '@animahealth/adk';

// Optional: Define schema for type-safe state
const stateSchema = {
  session: {
    mode: z.enum(['triage', 'consultation', 'followup']),
    count: z.number(),
  },
  user: { theme: z.string() },
  patient: { id: z.string() },
} satisfies StateSchema;

const sess = await session('my-app', {
  id: 'session-123',
  userId: 'user-456',
  patientId: 'patient-789',
  practiceId: 'practice-012',
});

// Property-access state API (session scope is default)
sess.state.mode = 'triage';        // session state (shorthand)
sess.state.count = 0;
sess.state.user.theme = 'dark';    // other scopes explicit
sess.addMessage('Hello!');
```

### Session Methods

```typescript
session.clone();

session.addMessage(text, invocationId?);

session.addToolResult(callId, result);  // For non-yielding tool results

session.addToolInput(callId, input);    // For yielding tool input

session.append(events);

const json = session.toJSON();

const restored = BaseSession.fromSnapshot({
  appName: 'my-app',
  id: 'session-123',
  events: storedEvents,
  userState: { theme: 'dark' },
  patientState: { allergies: ['penicillin'] },
});

session.bindSharedState('patient', stateRef, (key, value) => {
  persistToDatabase(key, value);
});

session.onStateChange((event) => {
  console.log('State changed:', event.scope, event.changes);
});

session.stateAt(eventIndex);             // Snapshot at index
session.forkAt(eventIndex);              // Isolated copy at index
session.eventIndexOf(eventId);           // Find index by event ID
session.invocationBoundary(invocationId); // Start/end of invocation
```

### PersistentSessionService

For production use, `PersistentSessionService` provides DynamoDB-backed persistence with optional OpenSearch indexing:

```typescript
import { session } from '@animahealth/adk';
import { PersistentSessionService } from '@animahealth/adk/persistence';

const sessionService = new PersistentSessionService({
  appName: 'my-app',
  dynamoTableName: 'adk-sessions',
  opensearch: {
    enabled: true,
    indexName: 'adk-sessions',
  },
});

const sess = await session('my-app', {
  sessionService,
  id: 'session-123',
  userId: 'user-456',
});

const retrieved = await sessionService.getSession('my-app', 'session-123');

await sessionService.deleteSession('my-app', 'session-123');

await sessionService.bindSessionScope(sess, 'patient', 'patient-789');
```

Shared state (`user`, `patient`, `practice`) is persisted separately and automatically bound to sessions. State updates use optimistic concurrency control.

### State Scopes

State is organized into scopes with different persistence characteristics:

| Scope      | Persistence               | Use Case                   | Audit Trail   |
| ---------- | ------------------------- | -------------------------- | ------------- |
| `session`  | Current session only      | Conversation-specific data | ✅ Logged     |
| `user`     | Across user sessions      | User preferences           | ✅ Logged     |
| `patient`  | Across patient encounters | Patient history            | ✅ Logged     |
| `practice` | Organization-wide         | Practice settings          | ✅ Logged     |
| `temp`     | Cleared each model step   | Intermediate calculations  | ❌ Not logged |

```typescript
// Session state (shorthand - no .session prefix needed)
ctx.state.mode = 'triage';
ctx.state.count = 42;
const { mode, count } = ctx.state;  // destructuring
const allSession = { ...ctx.state }; // spread to get all keys

// Bulk updates with .update()
ctx.state.update({ mode: 'consultation', count: 100 });
ctx.state.user.update({ theme: 'dark', notifications: true });

// Other scopes (explicit prefix required)
ctx.state.user.theme = 'dark';
const diagnoses = ctx.state.patient.diagnoses;
ctx.state.practice.oldSetting = undefined; // delete
ctx.state.temp.scratch = { intermediate: 'data' };
```

### State Change Auditing

State changes are recorded as events:

```typescript
{
  type: 'state_change',
  scope: 'patient',
  source: 'observation',
  changes: [{ key: 'diagnosis', oldValue: undefined, newValue: 'hypertension' }]
}
```

- **Observation**: Logged when reading shared state (`user`, `patient`, `practice`) that has changed since last read
- **Mutation**: Logged when writing to any non-temp state

### Session Status

Session status is computed from events:

```typescript
session.status;
session.pendingYieldingCalls;
session.currentAgentName;
```

| Status           | Description                           |
| ---------------- | ------------------------------------- |
| `active`         | Execution in progress or ready        |
| `awaiting_input` | Waiting for tool result or user input |
| `completed`      | Finished successfully                 |
| `error`          | Ended with error                      |

### Historical State & Time Travel

Query session state at any point in history for debugging, context rendering, evals, or conversation forking:

```typescript
// Get snapshot at event index - includes all state scopes and execution context
const snapshot = session.stateAt(42);
snapshot.sessionState; // Session-scoped state
snapshot.userState; // User-scoped state (reconstructed from events)
snapshot.patientState; // Patient-scoped state
snapshot.practiceState; // Practice-scoped state
snapshot.status; // 'active' | 'awaiting_input' | 'completed' | 'error'
snapshot.currentAgentName; // Active agent at this point
snapshot.invocationTree; // Full invocation hierarchy

// Fork session at historical point (creates isolated copy)
const forked = session.forkAt(50);
forked.addMessage('Try different path');
await runner.run(agent, forked); // Original session unchanged
```

#### Lookup by Event ID

When you have an event ID (e.g., from logs or persistence), convert it to an index first:

```typescript
const index = session.eventIndexOf('evt-abc123');
if (index !== undefined) {
  const snapshot = session.stateAt(index);
  const forked = session.forkAt(index);
}
```

#### Invocation Boundaries

Find the start and end indices of a specific invocation:

```typescript
const boundary = session.invocationBoundary('inv-xyz789');
if (boundary) {
  boundary.invocationId; // 'inv-xyz789'
  boundary.agentName; // 'my_agent'
  boundary.startIndex; // Index of invocation_start event
  boundary.endIndex; // Index of invocation_end event (undefined if still running)
}
```

#### Standalone Utilities

For working with raw event arrays outside of a session instance:

```typescript
import {
  computeStateAtEvent,
  snapshotAt,
  findEventIndex,
  findInvocationBoundary,
} from '@animahealth/adk';

const state = computeStateAtEvent(events, 42, 'session'); // Single scope
const snapshot = snapshotAt(events, 42); // Full snapshot
const index = findEventIndex(events, 'evt-abc123'); // Event ID → index
const boundary = findInvocationBoundary(events, 'inv-xyz789'); // Invocation span
```

## Running Agents

### Simple API

```typescript
import { run } from '@animahealth/adk';

const result = await run(myAgent, 'Hello!');

// With options
const result = await run(myAgent, {
  input: 'Hello!',
  timeout: 30000,
  onStream: (event) => console.log(event),
  onStep: (events, session, runnable) => console.log('Step completed'),
});
```

### With Session Control

```typescript
import { run, session, runner } from '@animahealth/adk';

const sess = await session('app', { id: 'session-123' });
sess.state.update({ session: { mode: 'debug' } });

const r = runner({ middleware: [loggingMiddleware()] });

const result = await run(myAgent, {
  session: sess,
  runner: r,
  input: 'Hello!',
});
```

### Streaming

```typescript
for await (const event of run(myAgent, 'Hello!')) {
  switch (event.type) {
    case 'thought_delta':
      process.stdout.write(event.delta);
      break;
    case 'assistant_delta':
      process.stdout.write(event.delta);
      break;
    case 'tool_call':
      console.log(`Tool: ${event.name}(${JSON.stringify(event.args)})`);
      break;
    case 'tool_result':
      console.log(`Result: ${JSON.stringify(event.result)}`);
      break;
  }
}
```

## Yield & Resume

The ADK supports yields for serverless and human-in-the-loop workflows:

```typescript
const result = await run(agent, { session: sess });

if (result.status === 'yielded') {
  if (result.pendingCalls.length > 0) {
    const call = result.pendingCalls[0];
    sess.addToolInput(call.callId, await askUser(call.args));
  } else if (result.awaitingInput) {
    sess.addMessage(await getNextMessage(), result.yieldedInvocationId);
  }
  await run(agent, { session: sess });
}
```

| Status        | Cause                       | Resume with                                     |
| ------------- | --------------------------- | ----------------------------------------------- |
| `yielded`     | Tool with `yieldSchema`     | `session.addToolInput(callId, input)`           |
| `yielded`     | Loop with `yields: true`    | `session.addMessage(text, yieldedInvocationId)` |
| `completed`   | Agent finished successfully | -                                               |
| `error`       | Unhandled error             | -                                               |
| `transferred` | Agent transferred control   | -                                               |

Use `validateResumeState(session.events)` to check for unresolved yields before resuming.

### Lambda API Example

A minimal Lambda handler for frontend integration:

```typescript
// handlers/conversation/runAgent.ts
import { z } from 'zod';
import commonMiddleware from '../../libs/commonMiddleware';
import { zvalidate } from '../../libs/tools/validation';
import { runConversation } from './services/runConversation';

const schema = z.object({
  sessionId: z.string().optional(),
  message: z.string().optional(),
  yieldResponse: z
    .object({
      callId: z.string().optional(),
      invocationId: z.string().optional(),
      input: z.unknown(),
    })
    .optional(),
});

async function handler(event: { input: unknown }) {
  return runConversation(zvalidate(schema, event.input));
}

export const main = commonMiddleware(handler);
```

```typescript
// handlers/conversation/services/runConversation.ts
import { run, session } from '@animahealth/adk';
import { PersistentSessionService } from '@animahealth/adk/persistence';
import { conversationAgent } from '../agent';

const sessionService = new PersistentSessionService();

interface Input {
  sessionId?: string;
  message?: string;
  yieldResponse?: { callId?: string; invocationId?: string; input: unknown };
}

export async function runConversation(input: Input) {
  const s = input.sessionId
    ? await sessionService.get(input.sessionId)
    : await session('conversation', { sessionService });

  if (input.yieldResponse?.callId) {
    s.addToolInput(input.yieldResponse.callId, input.yieldResponse.input);
  } else if (input.yieldResponse?.invocationId) {
    s.addMessage(
      String(input.yieldResponse.input),
      input.yieldResponse.invocationId,
    );
  } else if (input.message) {
    s.addMessage(input.message);
  }

  const result = await run(conversationAgent, { session: s });
  await sessionService.save(s);

  if (result.status === 'yielded') {
    const pending = result.pendingCalls?.[0];
    return {
      sessionId: s.id,
      status: 'awaiting_input',
      pendingYield: pending
        ? {
            type: 'tool',
            callId: pending.callId,
            toolName: pending.name,
            args: pending.args,
          }
        : { type: 'loop', invocationId: result.yieldedInvocationId },
    };
  }

  const lastAssistant = s.events.filter((e) => e.type === 'assistant').pop();
  return {
    sessionId: s.id,
    status: result.status,
    message: lastAssistant?.text,
  };
}
```

Frontend calls:

1. `POST { message: "Hello" }` → response or `{ status: 'awaiting_input', pendingYield }`
2. `POST { sessionId, yieldResponse: { callId, input } }` → continues execution

## Hooks

Hooks provide lifecycle interception points for guardrails, logging, transfers, and custom logic:

```typescript
const myAgent = agent({
  hooks: {
    beforeAgent: (ctx) => {
      if (ctx.state.blocked) return 'Request blocked';
      if (ctx.state.needsEscalation) return escalationAgent;
    },
    afterAgent: (ctx, output) => output.toUpperCase(),
    beforeModel: (ctx, renderCtx) => {
      if (ctx.state.shouldTransfer) return targetAgent;
      if (containsPII(renderCtx.events)) {
        return {
          stepEvents: [{ type: 'assistant', text: 'PII detected' }],
          terminal: true,
        };
      }
    },
    afterModel: (ctx, result) => {
      if (result.stepEvents.some((e) => e.text?.includes('urgent'))) {
        return urgentAgent;
      }
      return result;
    },
    beforeTool: (ctx, call) =>
      call.name === 'dangerous' ? { error: 'Blocked' } : undefined,
  },
});
```

| Hook          | Return to override                                                         |
| ------------- | -------------------------------------------------------------------------- |
| `beforeAgent` | Return string to short-circuit, or `Runnable` to transfer                  |
| `afterAgent`  | Return modified output                                                     |
| `beforeModel` | Return `{ stepEvents, terminal }` to skip model, or `Runnable` to transfer |
| `afterModel`  | Return modified model result, or `Runnable` to transfer                    |
| `beforeTool`  | Return tool result to skip execution                                       |
| `afterTool`   | Return modified tool result                                                |

## Middleware

Middleware provides composable cross-cutting concerns that wrap the entire agent lifecycle:

```typescript
import { runner, loggingMiddleware } from '@animahealth/adk';

const r = runner({
  middleware: [loggingMiddleware({ onLog: customLogger })],
});

const myAgent = agent({
  middleware: [customMiddleware],
});
```

Middleware implements the `Middleware` interface:

```typescript
const costTracker: Middleware = {
  name: 'cost-tracker',
  onStream: (event) => {
    if (event.type === 'model_end' && event.usage) {
      recordTokenUsage(event.usage);
    }
  },
  afterModel: (ctx, result) => {
    ctx.state.tokenCount = 
      ((ctx.state.tokenCount as number) ?? 0) + (result.usage?.totalTokens ?? 0);
  },
};
```

### Built-in Middleware

| Middleware          | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `loggingMiddleware` | Log execution lifecycle events                                     |
| `cliMiddleware`     | Stream events to stdout (for scripts, not the interactive `cli()`) |

## Error Handlers

Error handlers define recovery strategies for failures:

```typescript
import {
  runner,
  retryHandler,
  rateLimitHandler,
  timeoutHandler,
  loggingHandler,
} from '@animahealth/adk';

const r = runner({
  errorHandlers: [
    loggingHandler({ onError: (ctx) => logger.error(ctx) }),
    rateLimitHandler({ maxRetries: 5, baseDelay: 1000 }),
    retryHandler({
      maxAttempts: 3,
      baseDelay: 500,
      retryable: (ctx) => ctx.phase === 'model',
    }),
    timeoutHandler({ fallbackResult: { error: 'Timed out' } }),
  ],
});
```

### Recovery Actions

| Action     | Behavior                                |
| ---------- | --------------------------------------- |
| `throw`    | Re-throw the error                      |
| `skip`     | Continue with error result (tools only) |
| `abort`    | End execution immediately               |
| `retry`    | Retry with optional delay               |
| `fallback` | Use provided result                     |
| `pass`     | Pass to next handler                    |

### Custom Error Handler

```typescript
const customHandler: ErrorHandler = {
  name: 'custom',
  canHandle: (ctx) => ctx.error.message.includes('quota'),
  handle: (ctx) => ({
    action: 'fallback',
    result: { error: 'Quota exceeded' },
  }),
};
```

## Structured Output

Use `output()` for type-safe output configuration coupled to your state schema:

```typescript
import { output, type StateSchema } from '@animahealth/adk';

const stateSchema = {
  session: {
    product: z.object({ name: z.string(), price: z.number() }),
    notes: z.string(), // primitives bypass structured output
  },
} satisfies StateSchema;

const productAgent = agent({
  output: output(stateSchema, 'product'), // ✅ compile error if key doesn't exist
});

const notesAgent = agent({
  output: output(stateSchema, 'notes'), // raw string - no provider parsing
});
```

The `output()` function:

- **Compile-time validates** the key exists in `stateSchema.session`
- **Automatically detects** schema type to choose output strategy:
  - `z.object()`, `z.array()` → uses provider's structured output
  - `z.string()`, `z.number()`, `z.boolean()` → raw output (ADK handles casting)

## Stream Events

| Event Type          | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `thought_delta`     | Reasoning token (incremental)                            |
| `thought`           | Complete reasoning text                                  |
| `assistant_delta`   | Response token (incremental)                             |
| `assistant`         | Complete assistant response                              |
| `tool_call`         | Tool invocation                                          |
| `tool_result`       | Tool execution result                                    |
| `state_change`      | State observation or mutation                            |
| `invocation_start`  | Runnable begins execution                                |
| `invocation_end`    | Runnable completes                                       |
| `invocation_yield`  | Runnable yields control                                  |
| `invocation_resume` | Runnable resumes from yield                              |
| `model_start`       | Full context sent to model (messages, tools, schema)     |
| `model_end`         | Response metadata (usage, duration, cost, finish reason) |

## Parallel Execution

Parallel branches run on cloned sessions. Shared state (`user`, `patient`, `practice`) is passed by reference—avoid concurrent writes to the same keys.

```typescript
const fanout = parallel({
  name: 'analysis',
  runnables: [sentimentAgent, factCheckAgent, summaryAgent],
  failFast: false,
  branchTimeout: 30000,
  minSuccessful: 2,
});
```

## Testing

### New Testing API (runTest)

The new `runTest()` API provides a cleaner, more explicit step-based testing approach:

```typescript
import {
  runTest,
  user,
  model,
  input,
  result,
  setupAdkMatchers,
} from '@animahealth/adk/testing';

setupAdkMatchers();

test('tool call with yield', async () => {
  const { session, status } = await runTest(myAgent, [
    user('Calculate 2 + 2'),
    model({ toolCalls: [{ name: 'calculate', args: { expr: '2+2' } }] }),
    input({ calculate: { answer: 4 } }), // For yielding tools
    model({ text: 'The answer is 4' }),
  ]);

  expect(status).toBe('completed');
  expect(session.events).toHaveToolCall('calculate', { expr: '2+2' });
  expect(session.events).toHaveAssistantText(/answer is 4/);
});
```

| Step                      | Event Created     | Behavior                                   |
| ------------------------- | ----------------- | ------------------------------------------ |
| `user(text)`              | `UserEvent`       | Adds user message to session               |
| `model(response)`         | Varies            | Queues mock response, runs agent iteration |
| `input({ tool: value })`  | `ToolInputEvent`  | Provides user input for yielding tool      |
| `result({ tool: value })` | `ToolResultEvent` | Mocks tool result, skips execute()         |

For yielding tools with API calls, combine `input()` and `result()`:

```typescript
model({ toolCalls: [{ name: 'bookAppointment', args: { date: '2024-01-15' } }] }),
input({ bookAppointment: { confirmed: true } }),    // User confirms
result({ bookAppointment: { bookingId: '123' } }),  // Mock API response
```

### Jest Matchers

```typescript
expect(session.events).toHaveAssistantText(/hello/i);
expect(session.events).toHaveToolCall('calculate', { a: 2, b: 2 });
expect(session).toHaveState('session', 'key', expectedValue);
expect(session.events).toHaveEvent({ type: 'tool_call', name: 'calculate' });
expect(result).toHaveStatus('completed');
```

### User Primitives

For advanced testing and CLI/eval scenarios, the ADK provides User primitives:

```typescript
import { scriptedUser, humanUser, agentUser } from '@animahealth/adk';

// scriptedUser - for automated testing with runner
const user = scriptedUser({
  tools: {
    ask: [{ answer: 'yes' }, { answer: 'no' }], // Sequential responses
    confirm: (args, ctx) => ({ confirmed: true }), // Function handler
  },
  messages: ['Hello', 'Goodbye'], // For loop yields
});

const result = await runner.runWithUser(agent, session, { user });

// humanUser - for CLI interactive input
const human = humanUser({
  formatPrompt: (ctx) => `Enter input for ${ctx.toolName}: `,
  parseInput: (input, ctx) => JSON.parse(input),
});

// agentUser - for eval with LLM-powered simulated users
const simUser = agentUser({
  loop: conversationAgent,
  tools: { ask: questionAnsweringAgent },
  bridge: { formatPrompt, formatResponse },
});
```

### MockAdapter & Utilities

```typescript
import {
  MockAdapter,
  testAgent,
  createTestSession,
  collectStream,
} from '@animahealth/adk/testing';
import { runner } from '@animahealth/adk';

const mockAdapter = new MockAdapter({
  responses: [{ text: 'Hello' }],
  defaultResponse: { text: 'Default' },
});

const r = runner({ adapters: { openai: mockAdapter } });
```

### Running Tests

```bash
npm run test:adk -- agents/reasoning.test.ts
```

## Architecture

| Path          | Purpose                                     |
| ------------- | ------------------------------------------- |
| `core/`       | Runner, tools, orchestration primitives     |
| `agents/`     | Runnable factories and execution logic      |
| `session/`    | Event ledger, state management, persistence |
| `providers/`  | LLM adapters (OpenAI, Gemini)               |
| `context/`    | Render pipeline for model context           |
| `middleware/` | Cross-cutting concerns (logging, streaming) |
| `errors/`     | Error handling and recovery strategies      |
| `cli/`        | Interactive terminal UI (React/Ink)         |
| `testing/`    | Scenario DSL, mocks, Jest matchers          |
