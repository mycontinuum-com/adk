# Examples

Nineteen single-file programs. Each one runs on its own — read it, run it, edit it.

```bash
pnpm install && pnpm run build   # the examples import the package by name
export OPENAI_API_KEY=sk-...     # or GEMINI_API_KEY / ANTHROPIC_API_KEY, per example
npx tsx examples/quickstart.ts
```

`quickstart.ts` is the one to read first. Everything else assumes it.

## Building an agent

| Example | What it shows |
| --- | --- |
| `quickstart.ts` | The smallest complete program: one tool, one agent, one run. |
| `assistant.ts` | A chat loop that keeps one session across turns. |
| `step.ts` | Steps: your own code in the run, with routing and signals. |
| `staticFlow.ts` | Sequence, parallel, and loop over a content pipeline. |
| `dynamicFlow.ts` | Handoffs at runtime — run, spawn, dispatch, transfer. |
| `concurrency.ts` | Several agents in flight at once, and what the ledger records. |
| `spec.ts` | One definition reused across apps. |
| `yieldResume.ts` | The agent that stops for a human and resumes later. |

## Models and input

| Example | What it shows |
| --- | --- |
| `reasoning.ts` | Reasoning models across OpenAI, Gemini, and Claude. |
| `vision.ts` | Images and documents as model input. |
| `assistant-vertex.ts` | Gemini through Vertex AI. Set your own GCP project. |
| `realtime.ts` | Realtime model configuration. |

## Tools, voice, and serving

| Example | What it shows |
| --- | --- |
| `webSearch.ts` | Web search and page fetching as agent tools. |
| `mcp/filesystem.ts` | An MCP server over stdio. |
| `mcp/github.ts` | An MCP server over HTTP, with tool filtering. |
| `voice.ts` | A voice agent on LiveKit. Needs a LiveKit deployment. |
| `voice-eval.ts` | Scoring a voice agent against scripted callers. |
| `lambda-rest.ts` | The REST handler behind AWS Lambda. |
| `lambda-agui.ts` | The AG-UI streaming handler behind AWS Lambda. |

## What each one needs

Most need only `OPENAI_API_KEY`. The exceptions:

- `reasoning.ts` and `assistant-vertex.ts` — Gemini or Claude credentials.
- `webSearch.ts` — `SERPER_API_KEY`, and `pnpm add jsdom @mozilla/readability turndown` for page
  extraction.
- `voice.ts` and `voice-eval.ts` — a LiveKit deployment and `@livekit/agents`.
- `lambda-rest.ts` and `lambda-agui.ts` — a session store; both read one from the environment.
- `mcp/*.ts` — `@modelcontextprotocol/sdk` and the server each one names.

Runnable documentation for the same surfaces, with editable cells, is at
[adk.animahealth.com](https://adk.animahealth.com).
