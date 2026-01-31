# ADK Examples

These examples demonstrate core ADK patterns and can be run directly.

## Prerequisites

```bash
npm install
npm run build

# Set your API key
export OPENAI_API_KEY=sk-...
# or for other providers
export GEMINI_API_KEY=...
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
```

## Examples

| Example          | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `quickstart.ts`  | Minimal agent with calculator tool                      |
| `assistant.ts`   | Interactive chat loop with tools                        |
| `yieldResume.ts` | Human-in-the-loop approval workflow                     |
| `reasoning.ts`   | Multi-provider reasoning models                         |
| `dynamicFlow.ts` | Dynamic orchestration (call, spawn, dispatch, transfer) |
| `step.ts`        | Steps with routing, gates, and signals                  |
| `staticFlow.ts`  | Full content pipeline (parallel, sequence, loop)        |

## Running Examples

```bash
npx tsx examples/quickstart.ts
npx tsx examples/assistant.ts
npx tsx examples/yieldResume.ts
```

## More Examples

For additional production-style examples (clinical triage, document research),
see the anima-service repository:

- `scripts/adk/examples/clinician/` - Multi-agent clinical triage system
- `scripts/adk/examples/document-researcher/` - Research assistant with sub-agents
- `scripts/adk/examples/request-researcher/` - Request dataset analysis
