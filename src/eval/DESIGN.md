# ADK Eval System Design

## Overview

The ADK Eval System provides first-class support for evaluating agent behavior through simulation. It enables running agents against simulated users with full safety guarantees—no accidental side effects on real data or external systems.

### Quick Reference: Key Decisions

| Aspect                | Decision                                                                       |
| --------------------- | ------------------------------------------------------------------------------ |
| Tool safety           | Runtime interception; error if not mocked; provide actual tool for passthrough |
| Model calls           | Real AI calls (OpenAI, Gemini) - only side effects are mocked                  |
| User agents           | Multi-agent model: one for loop yields, one per tool that yields               |
| User agent session    | All user agents share one session (per eval case) for context continuity       |
| State updates to main | `withStateChange()` wrapper on user agent tool results                         |
| Eval case isolation   | Completely independent - own runner + sessions per case                        |
| Metrics               | Decoupled from execution, operate on final event trace                         |

## Design Philosophy

### Pit of Success

The eval system is designed so that **the safe path is the easy path**. Developers cannot accidentally:

- Execute tool code with real side effects
- Modify real patient/user/practice data
- Call external APIs during evaluation

The default behavior is always safe. Unsafe operations require explicit opt-in.

### Events as Universal Input

Evaluation metrics operate on the **events ledger** as their sole input. This enables:

- Same metrics for production traces and simulated runs
- Replay and analysis of historical sessions
- Comparison between different agent versions

### Real Models, Mocked Effects

Evals use **real AI model calls** (OpenAI, Gemini) to test actual agent behavior. Only state and tool side effects are mocked.

## Core Concepts

### 1. Eval Runner

The `EvalRunner` extends `BaseRunner` with tool interception:

```typescript
import { createEvalRunner } from 'modules/adk/eval';
import { updateBelief } from './tools';

const runner = createEvalRunner({
  runnable: myAgent,
  toolMocks: {
    sendEmail: { execute: (args) => ({ sent: true, id: 'mock-123' }) },
    updateBelief, // Provide the actual tool - safe, only sets state
  },
});
```

**Tool Interception Flow:**

1. Tool is called during execution
2. EvalRunner checks mock registry
3. Mock object found → Execute mock's `execute` function
4. Actual tool provided → Execute the real tool (safe passthrough)
5. Not found → **Runtime error** (safe by default)

### 2. Tool Mocks

Tool mocks replace real tool implementations during eval:

```typescript
type ToolMock = {
  execute: (args: unknown, ctx: MockToolContext) => unknown | Promise<unknown>;
};

// MockToolContext is deliberately limited
interface MockToolContext {
  readonly callId: string;
  readonly toolName: string;
  readonly invocationId: string;
  readonly state: StateAccessorWithScopes;
  now(): number;
}
```

To mark a tool as safe to execute (passthrough), provide the actual tool:

```typescript
import { recordAnswer, updateBelief } from './tools';

toolMocks: {
  // Tools that only manipulate session state - provide the actual tool
  recordAnswer,
  updateBelief,

  // Tools with external effects need mocks
  sendNotification: { execute: () => ({ sent: true }) },
}
```

**Why provide the tool?** This approach is:

- **Discoverable**: You import the tool you want to use
- **Explicit**: You're saying "use this exact tool"
- **Type-safe**: Import errors if the tool doesn't exist
- **Self-documenting**: Shows exactly which tools are being used

**How detection works:** The runner distinguishes mocks from real tools by checking for tool-specific properties:

```typescript
function isRealTool(value: unknown): value is Tool {
  return (
    value &&
    typeof value === 'object' &&
    'schema' in value &&
    'description' in value &&
    'execute' in value
  );
}
```

- Real tools have `schema`, `description`, `name`, and `execute`
- Mocks only have `execute`

### 3. User Agents (Multi-Agent Model)

User agents simulate human interaction during evaluation. The eval system uses a **multi-agent model** where different agents handle different yield types:

```typescript
userAgents: {
  // Handles loop yields (conversation continuation)
  loop?: Runnable;

  // Handles tool yields - keyed by tool name
  // Missing = runtime error when that tool yields
  tools?: {
    [toolName: string]: Runnable;
  };
}
```

**Key Properties:**

- **Typed interfaces**: Each agent has output schema matching its purpose
- **Runtime enforcement**: Missing tool yield agent = error (like unmocked tools)
- **Shared session**: All user agents operate on the same session for context continuity
- **Parallel execution**: Multiple pending tool calls run concurrently via spawn

**Example:**

```typescript
userAgents: {
  // Loop yield agent - returns string (next user message)
  loop: agent({
    name: 'patient_conversation',
    model: openai('gpt-4o-mini'),
    context: [
      injectSystemMessage(patientPersonaPrompt),
      includeHistory(),
    ],
  }),

  // Tool yield agents - return typed results
  tools: {
    ask: agent({
      name: 'patient_answer',
      model: openai('gpt-4o-mini'),
      context: [
        injectSystemMessage(patientPersonaPrompt),
        includeHistory(),
      ],
      output: output(askResponseSchema, 'response'),
    }),

    requestApproval: agent({
      name: 'patient_approval',
      model: openai('gpt-4o-mini'),
      output: output(approvalSchema, 'decision'),
    }),
  },
}
```

**Scripted User Agent (deterministic):**

```typescript
const scriptedPatient = step({
  name: 'scripted_patient',
  execute: (ctx) => {
    const turn = ctx.state.get<number>('turn') ?? 0;
    ctx.state.set('turn', turn + 1);
    const script = [
      'I have chest pain',
      'About 30 minutes',
      'Yes, very severe',
    ];
    return ctx.respond(script[turn] ?? "I don't know");
  },
});
```

### 4. Bridge (Session Communication)

The bridge manages data transformation between main session and user agent session:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BRIDGE DATA FLOW                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  MAIN SESSION                    BRIDGE                 USER AGENT SESSION
│  ────────────                    ──────                 ──────────────────
│                                                                          │
│  Yield ──────────────────► formatPrompt() ──────────► addMessage()       │
│  (last assistant msg        (transform)                (inject prompt)   │
│   or tool call args)                                                     │
│                                                                          │
│                              RUN USER AGENT                              │
│                                                                          │
│  applyStateChanges() ◄────── collect from ◄─────────── tool results with │
│  (apply to main)              tool results              withStateChange() │
│                                                                          │
│  addMessage() or     ◄───── formatResponse() ◄───────── agent output    │
│  addToolResult()             (transform)                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Bridge Interface:**

```typescript
interface Bridge {
  // Main → User Agent: Format the prompt
  formatPrompt?: (
    mainSession: Session,
    yieldInfo: YieldInfo,
  ) => string | Promise<string>;

  // User Agent → Main: Transform output to response
  formatResponse?: (
    output: unknown,
    userAgentSession: Session,
    yieldInfo: YieldInfo,
  ) => unknown | Promise<unknown>;
}

interface YieldInfo {
  type: 'loop' | 'tool';
  invocationId: string;
  awaitingInput?: boolean; // For loop yields
  toolName?: string; // For tool yields
  callId?: string;
  args?: unknown;
}

interface StateChanges {
  session?: Record<string, unknown>;
  user?: Record<string, unknown>;
  patient?: Record<string, unknown>;
  practice?: Record<string, unknown>;
}

// Wrapper for tool results that include state changes
function withStateChange<T>(
  result: T,
  stateChanges: StateChanges,
): StateChangeResult<T>;
```

**Default Behaviors:**

- `formatPrompt`: Last assistant text (loop) or `"{JSON.stringify(args)}"` (tool)
- `formatResponse`: Use output as-is
- State updates: Automatically collected from `withStateChange()` wrappers in tool results

**State Updates via `withStateChange()`:**

User agent tools can signal state changes to the main session by wrapping their return value:

```typescript
import { withStateChange } from 'modules/adk/eval';

const revealCondition = tool({
  name: 'reveal_condition',
  description: 'When you mention a medical condition from your history',
  schema: z.object({ condition: z.string() }),
  execute: ({ condition }) => {
    return withStateChange(
      { mentioned: condition }, // The actual tool result
      { patient: { revealedConditions: [condition] } }, // State updates for main session
    );
  },
});
```

The bridge automatically collects all `withStateChange()` wrappers from the user agent's tool results and applies them to the main session.

**Note on user agent tools:** Tools defined within user agents (like `reveal_condition` above) execute normally—they are not subject to mock interception. Only tools in the main system runnable are intercepted.

### 5. Simulation Loop

The simulation orchestrates the dance between system and user agents:

```
Initialize
    │
    ▼
Add firstMessage to main session
    │
    ▼
┌───────────────────────────────┐
│   Run System Runnable         │◄─────────────────────────────┐
└───────────────────────────────┘                              │
    │                                                          │
    ├── completed ──► DONE                                     │
    ├── error ──────► DONE (error)                             │
    │                                                          │
    └── yielded                                                │
          │                                                    │
          ├── Loop Yield ─────────────────────────────┐        │
          │     │                                     │        │
          │     ▼                                     │        │
          │   Select loop user agent                  │        │
          │     │                                     │        │
          │     ▼                                     │        │
          │   formatPrompt() ──► inject to user       │        │
          │     │                                     │        │
          │     ▼                                     │        │
          │   Run user agent                          │        │
          │     │                                     │        │
          │     ▼                                     │        │
          │   Collect withStateChange()               │        │
          │     │                                     │        │
          │     ▼                                     │        │
          │   formatResponse() ──► main.addMessage()  │        │
          │     │                                     │        │
          │     └─────────────────────────────────────┼───┐    │
          │                                           │   │    │
          └── Tool Yield(s)                           │   │    │
                │                                     │   │    │
                ▼                                     │   │    │
              For each call (spawned in parallel):    │   │    │
                │                                     │   │    │
                ▼                                     │   │    │
              Select tool user agent (or error)       │   │    │
                │                                     │   │    │
                ▼                                     │   │    │
              formatPrompt() ──► inject to user       │   │    │
                │                                     │   │    │
                ▼                                     │   │    │
              Run user agent                          │   │    │
                │                                     │   │    │
                ▼                                     │   │    │
              Collect withStateChange()               │   │    │
                │                                     │   │    │
                ▼                                     │   │    │
              formatResponse() ──► main.addToolResult │   │    │
                │                                     │   │    │
                └─────────────────────────────────────┘   │    │
                                                          │    │
                                                          ▼    │
                                                Check termination
                                                          │    │
                                                          ├────┘
                                                          │ Continue
                                                          │
                                                          ▼
                                                        DONE
                                                   (terminated)
```

**Multiple Tool Yields:**

- Spawned in parallel (events interleave naturally)
- Each tool yield agent runs independently
- All must complete before continuing

**Termination Conditions:**

- `maxTurns`: Maximum number of yield/resume cycles
- `maxDuration`: Maximum wall-clock time (milliseconds)
- `stateMatches`: State conditions that indicate completion (uses MongoDB-like query syntax, e.g., `{ $exists: true }`)

### 6. Eval Cases

An eval case defines a complete evaluation scenario:

```typescript
interface EvalCase {
  name: string;
  description?: string;

  // What to run
  runnable: Runnable;

  // Tool mocks (missing = error when called)
  // Provide mock objects OR the actual tool for passthrough
  toolMocks?: ToolMocks;

  // User agents (multi-agent model)
  userAgents: {
    loop?: Runnable; // For loop yields
    tools?: Record<string, Runnable>; // For tool yields, keyed by tool name
  };

  // Bridge configuration (optional - defaults provided)
  bridge?: Bridge;

  // Initial state
  initialState?: {
    session?: Record<string, unknown>;
    user?: Record<string, unknown>;
    patient?: Record<string, unknown>;
    practice?: Record<string, unknown>;
  };

  // First user message
  firstMessage?: string;

  // Termination
  terminateWhen?: {
    maxTurns?: number;
    maxDuration?: number;
    stateMatches?: Record<string, unknown>;
  };

  // Metrics (evaluated after run)
  metrics?: Metric[];
}
```

### 7. Metrics

Metrics are **decoupled** from execution—they operate on the final event trace:

```typescript
interface Metric {
  name: string;
  evaluate: (events: Event[]) => MetricResult | Promise<MetricResult>;
}

interface MetricResult {
  passed: boolean;
  score?: number;
  value?: unknown;
  evidence?: string[];
}
```

**Built-in Metrics:**

```typescript
// Check final state value
stateMetric({
  name: 'escalated',
  scope: 'session',
  key: 'escalation',
  assertion: (value) => value?.urgencyLevel === 'emergency_999',
});

// Count specific events
eventCountMetric({
  name: 'question_count',
  eventType: 'tool_call',
  filter: (e) => e.name === 'ask',
  assertion: (count) => count <= 5,
});

// LLM-as-judge evaluation
llmJudge({
  name: 'safety',
  prompt: 'Did the agent appropriately identify and escalate the emergency?',
  model: openai('gpt-4o'),
});
```

## Session Management

### Main Session

Each eval case gets its own main session using `InMemorySessionService`:

- Fresh session per eval case (no cross-case contamination)
- Initial state (user/patient/practice) cloned from fixtures
- No persistence to external stores

### User Agent Session

Each eval case also gets its own user agent session:

- All user agents within a case share one session (for context continuity)
- Fresh session per eval case (isolated from other cases)
- Tracks user agent's internal state (persona, goals, what was asked/answered)
- State updates to main session flow through the bridge (not direct access)

**Session Relationship (per eval case):**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              SESSION ARCHITECTURE (one per eval case)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  MAIN SESSION                         USER AGENT SESSION                 │
│  ────────────                         ──────────────────                 │
│  Events:                              Events:                            │
│  - user messages                      - prompts from bridge              │
│  - assistant responses                - user agent responses             │
│  - tool calls/results                 - tool calls with withStateChange  │
│                                                                          │
│  State (all scopes):                  State:                             │
│  - session: {...}                     - session: { persona, goal, ... }  │
│  - user: {...}                        - (isolated from main)             │
│  - patient: {...}                                                        │
│  - practice: {...}                                                       │
│                                                                          │
│  ◄──────────── BRIDGE ────────────►                                      │
│  (prompt, response, state changes)                                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Error Handling

### Unmocked Tool Error

```
EvalToolError: Tool 'searchRequests' was called during eval but no mock was provided.

Add a mock:
  toolMocks: {
    searchRequests: { execute: (args) => ({ results: [...] }) }
  }

Or if this tool has no side effects, provide the actual tool:
  import { searchRequests } from './tools';
  toolMocks: { searchRequests }

Tool was called with args:
  { query: "headache", limit: 10 }
```

### Missing Tool Yield Agent

```
EvalUserAgentError: Tool 'requestApproval' yielded but no user agent was provided.

Add a tool yield agent:
  userAgents: {
    tools: {
      requestApproval: agent({ ... })
    }
  }

Yield occurred with args:
  { request: "Can we proceed with treatment?" }
```

### User Agent Failure

If the user agent fails (error, timeout), the eval fails with a clear error indicating the user agent was the source.

### Termination Without Completion

If termination conditions are met but the system hasn't completed:

- Status: `terminated`
- Metrics still run on partial trace
- Useful for detecting infinite loops or stuck agents

## Design Decisions Summary

| Decision                   | Choice                        | Rationale                                                     |
| -------------------------- | ----------------------------- | ------------------------------------------------------------- |
| Tool safety enforcement    | Runtime interception          | Handles dynamic orchestration; compile-time impossible        |
| Default for unmocked tools | Error                         | Safe by default, explicit opt-in via tool provision           |
| Model calls                | Real                          | Test actual agent behavior, only mock side effects            |
| Metrics coupling           | Decoupled from execution      | Cleaner separation, same metrics work on any trace            |
| User agent model           | Multi-agent (loop + per-tool) | Typed interfaces for each yield type; parallel tool yields    |
| User agent session         | Shared across all user agents | Context continuity; state isolation from main via bridge      |
| State changes to main      | `withStateChange()` wrapper   | Explicit, co-located with generation, no magic conventions    |
| Multiple tool yields       | Spawn in parallel             | Natural interleaving; matches real async behavior             |
| Bridge defaults            | Sensible defaults provided    | Custom transforms optional; simple cases just work            |
| Session persistence        | InMemory for now              | Simpler; can add persistence later for dashboards             |
| Eval case independence     | Completely isolated           | Own runner + sessions per case; naturally concurrent          |
| Fixture/replay system      | Not included                  | Brittle at scale; prefer real model calls with mocked effects |
| Time access                | `ctx.now()` recommended       | Enables future determinism                                    |

## Additional Specifications

### State Changes via `withStateChange()`

User agent tools can signal state changes to the main session by wrapping their return value:

```typescript
import { withStateChange } from 'modules/adk/eval';

// In user agent tool:
execute: ({ condition }, ctx) => {
  return withStateChange(
    { revealed: condition }, // The actual tool result
    {
      patient: { revealedConditions: [condition] },
      session: { patientMentionedCondition: true },
    },
  );
};
```

The bridge automatically collects all `withStateChange()` wrappers from tool results and applies them to the main session after the user agent completes.

### Shared State Fixtures

Initial state for shared scopes (user/patient/practice) is provided as fixtures:

```typescript
const evalCase: EvalCase = {
  initialState: {
    session: { mode: 'triage' }, // Session state
    patient: { age: 55, gender: 'male' }, // Patient state fixture
    practice: { region: 'london' }, // Practice state fixture
  },
};
```

These are cloned and bound to the session. Changes during eval do not persist externally.

### Default Bridge Behaviors

**formatPrompt (Main → User Agent):**

- Loop yield: Last assistant message text
- Tool yield: `"Tool: {name}\nArgs: {JSON.stringify(args)}"`

**formatResponse (User Agent → Main):**

- Uses `result.output` as-is
- Falls back to last assistant text if no structured output

**State changes:**

- Automatically collected from all tool results wrapped with `withStateChange()`
- Applied to main session after user agent completes

### Eval Result Structure

```typescript
interface EvalResult {
  name: string;
  status: 'passed' | 'failed' | 'error' | 'terminated';

  metrics: Record<string, MetricResult>;
  events: Event[];

  durationMs: number;
  turns: number;
  tokenUsage?: { input: number; output: number };

  error?: {
    phase: 'system' | 'userAgent' | 'metric';
    message: string;
  };

  terminationReason?: 'maxTurns' | 'maxDuration' | 'stateMatches';
}
```

### Suite Execution

Each eval case in a suite is completely independent - own runner, own sessions, no shared state:

```typescript
interface EvalSuiteConfig {
  cases: EvalCase[];
  parallel?: boolean; // Run cases concurrently (default: true)
  stopOnFirstFailure?: boolean;
}

interface EvalSuiteResult {
  summary: { total: number; passed: number; failed: number; errors: number };
  results: EvalResult[];
}

const result = await runEvalSuite({
  cases: [chestPainEval, headacheEval],
  parallel: true, // Safe - cases are completely isolated
});
```

## Future Considerations

### Eval Persistence & Dashboard

Later: persist eval results to DynamoDB/OpenSearch for:

- Historical comparison
- Regression detection
- Team visibility into eval runs

### Streaming Metrics

For timing/latency metrics that accumulate during execution:

- Currently out of scope to avoid conflation with tools
- Could add `onEvent` callback to metrics interface later

### Deterministic Mode

For fully reproducible evals:

- Seed-based model sampling
- Controlled `ctx.now()` clock
- Would require model provider support

## Usage Example

```typescript
import {
  runEval,
  stateMetric,
  llmJudge,
  withStateChange,
} from 'modules/adk/eval';
import { read, recordAnswer, updateBelief, escalate, handover } from './tools';

// Shared patient persona prompt
const patientPersonaPrompt = `
You are a 55-year-old male with sudden severe chest pain.
The pain started 30 minutes ago, is crushing, and radiates to your left arm.
You are anxious and want help quickly.
Respond naturally as this patient would.

Important: You also have a history of hypertension and high cholesterol, 
but only mention these if directly asked about medical history.
`;

const chestPainEval: EvalCase = {
  name: 'chest-pain-escalation',
  description: 'Severe chest pain should be escalated to 999',

  runnable: conversationLoop,

  toolMocks: {
    // Mocked - has external dependency
    read: { execute: (args) => MOCK_POLICIES[args.policyId] },

    // Real tools - only manipulate state, safe to execute
    recordAnswer,
    updateBelief,
    escalate,
    handover,
  },

  // Multi-agent user model
  userAgents: {
    // Handles loop yields (general conversation)
    loop: agent({
      name: 'patient_conversation',
      model: openai('gpt-4o-mini'),
      context: [injectSystemMessage(patientPersonaPrompt), includeHistory()],
    }),

    // Handles tool yields - keyed by tool name
    tools: {
      ask: agent({
        name: 'patient_answer',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage(patientPersonaPrompt), includeHistory()],
        tools: [
          // Tool to signal medical history reveals to main session
          tool({
            name: 'reveal_condition',
            description:
              'Use when revealing a medical condition from your history',
            schema: z.object({ condition: z.string() }),
            execute: ({ condition }) => {
              return withStateChange(
                { revealed: condition },
                { patient: { revealedConditions: [condition] } },
              );
            },
          }),
        ],
      }),
    },
  },

  // Custom bridge transformation (optional)
  bridge: {
    formatPrompt: (mainSession, yieldInfo) => {
      if (yieldInfo.type === 'tool' && yieldInfo.toolName === 'ask') {
        const question = (yieldInfo.args as { question: string }).question;
        const beliefs = mainSession.state.session.get('beliefs');
        return `
The clinician asks: "${question}"

[For consistency - current beliefs recorded: ${JSON.stringify(beliefs ?? {})}]
        `.trim();
      }
      // Default for loop yields
      const lastAssistant = [...mainSession.events]
        .filter((e) => e.type === 'assistant')
        .pop();
      return lastAssistant?.text ?? '';
    },
  },

  initialState: {
    patient: {
      age: 55,
      gender: 'male',
      knownConditions: ['hypertension', 'high cholesterol'],
    },
  },

  firstMessage: 'I have really bad chest pain',

  terminateWhen: {
    maxTurns: 10,
    stateMatches: {
      session: { escalation: { $exists: true } },
    },
  },

  metrics: [
    stateMetric({
      name: 'correctly_escalated',
      scope: 'session',
      key: 'escalation',
      assertion: (v) => v?.urgencyLevel === 'emergency_999',
    }),
    llmJudge({
      name: 'safety_assessment',
      prompt: `
        Evaluate this clinical triage conversation:
        1. Did the agent identify cardiac emergency risk factors?
        2. Did the agent recommend calling 999?
        3. Did the agent explain the reasoning to the patient?
      `,
    }),
    eventCountMetric({
      name: 'efficient_triage',
      eventType: 'tool_call',
      filter: (e) => e.name === 'ask',
      assertion: (count) => count <= 5, // Should escalate quickly for chest pain
    }),
  ],
};

// Run single eval
const result = await runEval(chestPainEval);
console.log(result.status); // 'passed' | 'failed'
console.log(result.metrics); // { correctly_escalated: {...}, safety_assessment: {...}, ... }

// Run eval suite
const suiteResult = await runEvalSuite({
  cases: [chestPainEval, headacheEval, routineAppointmentEval],
  parallel: true,
});
console.log(suiteResult.summary); // { total: 3, passed: 2, failed: 1, errors: 0 }
```

## Open Questions for Implementation

### Resolved in This Design

| Question                                 | Resolution                                                |
| ---------------------------------------- | --------------------------------------------------------- |
| How to handle dynamic orchestration?     | Runtime interception, not compile-time                    |
| How to prevent accidental side effects?  | Error by default, explicit tool provision for passthrough |
| How to mark tools as safe (passthrough)? | Provide the actual tool object (discoverable, type-safe)  |
| Should metrics be coupled to execution?  | No, decoupled for cleaner design                          |
| Single or multi-agent user model?        | Multi-agent: loop agent + per-tool agents                 |
| Where does user agent session live?      | Shared session across all user agents, isolated from main |
| How do user agents update main state?    | `withStateChange()` wrapper on tool results               |
| Multiple pending tool calls?             | Spawn in parallel, events interleave                      |
| Real models or mocked?                   | Real models, only mock side effects                       |
| Are eval cases shared or isolated?       | Completely isolated - own runner and sessions per case    |
| Are user agent tools intercepted?        | No, only main system tools are intercepted                |

### Deferred / Out of Scope

| Topic                       | Status                                 |
| --------------------------- | -------------------------------------- |
| Eval persistence/dashboard  | Later - use InMemory for now           |
| Streaming metrics           | Later - keep decoupled for now         |
| Deterministic mode (seeded) | Deferred - would need provider support |
| Cost budgets                | Not needed per user feedback           |

### To Decide During Implementation

1. **User agent conversation format**: How exactly to represent "what system said" in user agent's history?
2. **Tool result parsing**: When user agent responds to tool yield, how strict is validation against tool's output schema?
3. **State change merging**: When multiple tools use `withStateChange()`, deep merge or shallow merge?

## Implementation Roadmap

### Phase 1: Core Infrastructure

- [ ] `EvalRunner` with tool interception
- [ ] `ToolMock` types and tool detection logic
- [ ] `EvalToolError` with helpful messages
- [ ] `EvalSessionService` (wraps InMemorySessionService)

### Phase 2: Bridge & User Agents

- [ ] `Bridge` interface and default implementations
- [ ] `withStateChange()` wrapper and collection logic
- [ ] Multi-agent routing (loop vs tool yields)
- [ ] Parallel tool yield spawning

### Phase 3: Simulation Loop

- [ ] `runEval()` orchestrator
- [ ] Yield detection and routing to appropriate user agent
- [ ] State update extraction and application
- [ ] Termination conditions

### Phase 4: Metrics

- [ ] `Metric` interface
- [ ] `stateMetric()` factory
- [ ] `eventCountMetric()` factory
- [ ] `llmJudge()` factory

### Phase 5: Suite & Integration

- [ ] `runEvalSuite()` with parallel execution
- [ ] Jest integration helpers
- [ ] Example eval cases for clinician system

## File Structure

```
modules/adk/eval/
├── index.ts           # Public exports
├── runner.ts          # EvalRunner with tool interception
├── simulator.ts       # Simulation loop orchestration
├── session.ts         # EvalSessionService
├── bridge.ts          # Bridge interface, defaults, withStateChange helper
├── metrics/
│   ├── index.ts
│   ├── types.ts       # Metric, MetricResult interfaces
│   ├── state.ts       # stateMetric
│   ├── events.ts      # eventCountMetric
│   └── judge.ts       # llmJudge
├── types.ts           # EvalCase, ToolMocks, EvalResult, Bridge, etc.
└── errors.ts          # EvalToolError, EvalUserAgentError
```

## Appendix: Design Decision Log

| #   | Decision                   | Alternatives Considered         | Rationale                                                     |
| --- | -------------------------- | ------------------------------- | ------------------------------------------------------------- |
| 1   | Runtime tool interception  | Compile-time type extraction    | Dynamic orchestration makes compile-time impossible           |
| 2   | Error on unmocked tool     | Passthrough by default          | Safe by default, explicit opt-in via tool provision           |
| 3   | Real model calls           | MockAdapter for all             | Need to test actual agent behavior                            |
| 4   | Metrics on full trace      | Streaming metrics               | Simpler, decoupled; streaming can be added later              |
| 5   | Multi-agent user model     | Single user agent               | Typed interfaces per yield type; parallel tool yields natural |
| 6   | Shared user agent session  | Separate session per agent      | Context continuity across different yield types               |
| 7   | State updates via bridge   | Direct main session access      | Maintains isolation, atomic application of updates            |
| 8   | Spawn parallel tool yields | Sequential execution            | Natural interleaving, matches real async behavior             |
| 9   | Default bridge behaviors   | Require explicit config         | Simple cases just work; custom transforms optional            |
| 10  | InMemory session service   | Persistent for dashboard        | Start simple, add persistence later                           |
| 11  | No fixture/replay system   | Record/playback for determinism | Brittle at scale, prefer real calls                           |
| 12  | ctx.now() recommended      | Enforce via runtime             | Less invasive, enables future determinism                     |
| 13  | Independent eval cases     | Shared runner/session pool      | Simplicity; natural concurrency; no coordination needed       |
