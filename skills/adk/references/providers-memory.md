# Providers And Memory

Use this reference for model providers, provider profiles/options, provider auth, retry/error handling, pricing-sensitive options, vector memory, collection provisioning, and embeddings.

## Provider Imports

Prefer subpath imports so optional peer dependencies stay optional:

```typescript
import { openai } from '@animahealth/adk/openai'
import { gemini } from '@animahealth/adk/gemini'
import { claude } from '@animahealth/adk/claude'
import { eurouter } from '@animahealth/adk/eurouter'
```

The main entry still re-exports `openai`, `gemini` and `claude` for compatibility, but marks
those re-exports deprecated. Import `eurouter` from its subpath; the main entry exports
only its types.

## OpenAI

```typescript
openai('gpt-5.2', {
  temperature: 0,
  reasoning: { effort: 'none' },
})

const cachedModel = openai('gpt-5.6-luna', {
  promptCache: { key: 'notes:template-v1', mode: 'explicit', ttl: '30m' },
})

const cachedWriter = app.agent({
  name: 'cached_writer',
  model: cachedModel,
  context: [app.context.cacheableUser(stablePrefix), app.context.history()],
})

openai.realtime('gpt-4o-realtime', { voice: 'alloy' })
```

OpenAI endpoint auth is resolved in this order: Azure, OpenAI EU, standard OpenAI.

Common environment variables:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_API_VERSION`
- `OPENAI_EU_API_KEY`
- `OPENAI_API_KEY`

## Gemini

```typescript
gemini('gemini-3-flash-preview', {
  thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
})

gemini('gemini-3-flash-preview', {
  vertex: { project: 'anima-product', location: 'europe-west1' },
})

gemini.realtime('gemini-2.0-flash-live', { voice: 'Puck' })
```

AI Studio uses `GEMINI_API_KEY`. Vertex uses `GOOGLE_APPLICATION_CREDENTIALS` or `vertex.credentials`.

## Claude

Claude support is via Vertex AI:

```typescript
claude('claude-sonnet-4-5', {
  vertex: {
    project: 'anima-product',
    location: 'europe-west1',
    credentials: process.env.GCP_CREDENTIALS_PATH,
  },
  thinking: { budgetTokens: 4096 },
})
```

Enable Claude models in Google Cloud Model Garden and grant Vertex AI permissions.

## Self-hosted Chat Completions

Connect an OpenAI-compatible Chat Completions endpoint through its own adapter. The native
OpenAI adapter uses the Responses API and is not interchangeable with this integration.

```typescript
import { adk } from '@animahealth/adk'
import { chatCompletions, ChatCompletionsAdapter } from '@animahealth/adk/chat-completions'

const app = adk({
  adapters: {
    'chat-completions': new ChatCompletionsAdapter({
      baseURL: 'http://127.0.0.1:30000/v1',
    }),
  },
})
const agent = app.agent({
  name: 'assistant',
  model: chatCompletions('Qwen/Qwen3.8-27B', {
    maxTokens: 4096,
    chatTemplate: { reasoning_effort: 'xhigh', preserve_thinking: true },
  }),
  context: [app.context.history()],
})
```

Use a private tunnel to reach a temporary research server. `baseURL` is required. An optional
`apiKey` must be supplied explicitly; the adapter never reads OpenAI or EUrouter credentials.
It sends no EUrouter routing or residency metadata. Deploying and securing the endpoint remains
the caller's responsibility.

To use multiple hosts in one app, register named adapters and select one in each model:

```typescript
const app = adk({
  adapters: {
    base: new ChatCompletionsAdapter({ baseURL: 'http://127.0.0.1:30000/v1' }),
    trained: new ChatCompletionsAdapter({ baseURL: 'http://127.0.0.1:30001/v1' }),
  },
})
const baseAgent = app.agent({
  name: 'base',
  model: chatCompletions('Qwen/Qwen3.8-27B', { adapter: 'base' }),
  context: [app.context.history()],
})
const trainedAgent = app.agent({
  name: 'trained',
  model: chatCompletions('my-fine-tuned-model', { adapter: 'trained' }),
  context: [app.context.history()],
})
```

Each adapter owns its endpoint and optional credentials; each model owns its generation settings.
An explicit adapter name must be registered or the call fails. Omitting `adapter` uses the
`'chat-completions'` registration shown in the first example.

This text-only integration supports streaming, function tools, native JSON schema output,
retries before output begins, and durable reasoning replay. It shares EUrouter's Chat Completions
implementation and preserves `reasoning`, `reasoning_content`, and ordered `reasoning_details`
across tool calls and saved sessions. Keep thought events in `app.context.history()`. Native
reasoning is replayed only for the same endpoint, adapter name and requested model. Switching
any of these retains ordinary assistant and tool history without replaying native reasoning.
Endpoint identity is stored as a fingerprint; endpoint URLs and credentials are not added to
session history. Give a replaced checkpoint a new served model name to distinguish it from
the previous model at the same endpoint.

`reasoningEffort` sends the top-level `reasoning_effort` field. `chatTemplate` sends validated
`chat_template_kwargs` containing `enable_thinking`, `preserve_thinking`, or `reasoning_effort`.
Choose the fields supported by the server's pinned model template. These controls are not
interchangeable on every server. Qwen's qualified SGLang recipe uses the template settings shown
above. Calls do not inherit OpenAI token-price estimates.

Run `examples/self-hosted.ts --endpoint http://127.0.0.1:30000/v1` with `tsx` after building the
package. It makes two synthetic tool requests, closes and reopens SQLite between them, and checks
that reasoning messages are replayed unchanged. Its output contains counts and synthetic results,
not reasoning contents. Passing verifies protocol behavior, not production quality or throughput.

## EUrouter

Use EUrouter to select hosted models such as DeepSeek, Kimi, and GLM:

```typescript
import { adk } from '@animahealth/adk'
import { eurouter, EurouterAdapter } from '@animahealth/adk/eurouter'

const app = adk({
  adapters: {
    eurouter: new EurouterAdapter({
      apiKey: process.env.EUROUTER_API_KEY,
      routing: { only: ['tensorix'], maxRetentionDays: 0 },
    }),
  },
})

const agent = app.agent({
  name: 'assistant',
  model: eurouter('deepseek-v4-flash-0731', { maxTokens: 4096 }),
  context: [app.context.history()],
})
```

`kimi-k3` and `glm-5.3` are other model selections under the same provider. Model IDs are
opaque strings. Tools, structured output, and reasoning settings depend on the selected model
and serving host. This adapter accepts text input only. Check the [EUrouter catalog](https://www.eurouter.ai/models)
before a live run.

The adapter uses Chat Completions at `https://api.eurouter.ai/api/v1`. Without an explicit key,
it reads `EUROUTER_API_KEY`. Credentials and routing policy belong to the adapter, so an app's
agents share a connection policy. Model configuration contains generation settings only.

Routing defaults request EU processing, no training, and zero retention. `only` restricts the
eligible hosts. `order` expresses a preference and permits other hosts unless you also restrict
them. `allowFallbacks` controls gateway fallback within the eligible hosts. These API controls
do not replace an application's approved processing boundary or clinical release evaluation.
See [EUrouter routing](https://www.eurouter.ai/docs/concepts/routing).

The adapter retains tool-call IDs and reasoning continuation across turns. The ADK runner
executes tools and validates final output. Interrupted streams fail instead of silently replaying
already emitted text. This text integration does not add realtime voice or hosted provider tools.

### Reasoning across calls

With `app.context.history()`, the adapter automatically replays `reasoning`, `reasoning_content`,
and ordered `reasoning_details` on their original assistant messages. This includes tool
continuations and earlier user turns after a session-store reload. Empty text fields and structured
block metadata are retained. Opaque blocks stay in event `providerContext`; they are not displayed
as thought text. No extra model setting is needed for ADK replay.

Replay only works for events included in the model context. `pruneReasoning()` removes it;
`selectRecentEvents()` can remove thoughts even when it restores a companion tool call.
Keep those thoughts when the endpoint requires reasoning continuation.

The serving endpoint must also consume the returned reasoning. Model defaults do not establish
EUrouter host behavior:

| Model               | Upstream preservation behavior                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek V4.1 Flash | The [DeepSeek thinking API](https://api-docs.deepseek.com/guides/thinking_mode/) requires all prior `reasoning_content` when `tools` are supplied; without tools it ignores prior reasoning.    |
| GLM 5.3 Flash       | [Z.ai preserved thinking](https://docs.z.ai/guides/capabilities/thinking-mode) uses `thinking.clear_thinking: false`. It defaults on for the coding endpoint and off for the standard endpoint. |
| Qwen 3.8            | The [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B) enables `preserve_thinking` by default, retaining thinking from all historical messages.                                  |

These upstream controls are not EUrouter model options in the ADK. Confirm the selected host's
preservation behavior before depending on it. Local protocol tests prove ADK replay, not upstream
consumption or a quality improvement. Retained reasoning also occupies context.

Usage events retain the requested model, returned model, and serving provider when supplied.
Gateway calls never inherit native OpenAI price estimates. `reportedCostUSD` is populated only
when the gateway supplies a cost explicitly denominated in USD. Summary costs are omitted when
any call lacks the corresponding cost data.

From the repository root, build the package and run the synthetic example without a credential:

```bash
pnpm --filter @animahealth/adk build
pnpm --filter @animahealth/adk exec node --import tsx examples/eurouter.ts
```

The example drives the real SDK and ADK through a local streaming fixture. It calls an inventory
tool, replays its result, checks streamed text, and validates structured output for the three model
IDs. Its output is labelled `local-fixture`. Token counts come from the fixture and are not
measurements of a model.

The example defaults to `--output-mode prompt`. It includes the output schema and JSON instructions
in the system message, then ADK validates the response. Add `--output-mode native` to send a native
JSON schema request instead. Support for that request depends on the model and serving host.
The prompt asks the model to call the inventory tool once. The example checks that it actually
does so, without forcing a tool choice. Native structured output combined with tools needs a
separate live check for the selected model and serving host.

Once a development credential is available in `EUROUTER_API_KEY`, run the same synthetic task
against an explicitly selected live model:

```bash
pnpm --filter @animahealth/adk exec node --import tsx examples/eurouter.ts --live --model deepseek-v4-flash-0731
```

`--model` is repeatable. `--output-mode` accepts `prompt` or `native`. Live mode makes billable requests.
Do not use patient data in this example.
Local tests establish protocol handling. They do not establish a model's quality or live availability.

Live checks on September 16, 2026 passed for `deepseek-v4-flash-0731`, `kimi-k3`, and `glm-5.3`
with prompt-mode output and automatic tool selection. Each executed the inventory tool once,
returned the expected JSON values, and streamed its final text. Separate capability probes saw
Kimi and GLM reject native JSON schema requests, and GLM reject explicit `tool_choice`.
DeepSeek accepted native JSON schema with tools but skipped the required lookup in two attempts.
These observations apply to the tested routes at that time; repeat the check for a chosen model
and serving host before relying on those capabilities. Gateway charges used both USD and EUR,
so runs without complete USD charges omitted the combined `reportedCostUSD` total.

## Shared Model Options

Temperature is explicit and does not change reasoning settings. Omission preserves the provider
default; ADK does not insert a temperature or disable reasoning automatically.

- OpenAI forwards temperature when reasoning is omitted or explicitly `none`. With an active
  reasoning effort it retains the compatibility guard and omits temperature. Use `none` only on
  models supporting it; omission can select a reasoning default that rejects temperature.
- Claude forwards temperature (including zero) without `thinking`; with manual extended thinking
  it omits temperature because Anthropic prohibits changing it. Models that prohibit sampling
  even without thinking still reject it: the adapter does not override model capabilities.
- Gemini forwards temperature (including zero) independently of `thinkingConfig`. Google recommends
  keeping Gemini 3 sampling at its default of 1; explicit overrides remain the caller's choice.

Provider compatibility: [OpenAI](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2),
[Claude](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models),
[Gemini](https://ai.google.dev/gemini-api/docs/troubleshooting).

Common provider options include `temperature`, `maxTokens`, and `retry`. Provider-specific options include:

- OpenAI: `reasoning.effort`, explicit `promptCache` with prefixes marked by `app.context.cacheableUser(...)`.
- Gemini: `thinkingConfig.thinkingBudget`, `thinkingConfig.thinkingLevel`, `thinkingConfig.includeThoughts`, `vertex`.
- Claude: `thinking.budgetTokens`, `promptCache`, `vertex`.
- Realtime: `voice`, `turnDetection`, `inputTranscription`, `noiseReduction`, `stt`, `tts`, `providerOptions`; `inputTranscription` and `noiseReduction` are OpenAI-only in current adapters.

Vertex Claude supports `promptCache` with `enabled`, `ttl: '5m' | '1h'`, and `system: 'all' | 'tagged'`. Check `src/providers/` before documenting new models or option names.

## Provider Profiles

For production packages that compare models or vendors, create a small profile-to-model factory instead of spreading provider config through agents and CLIs.

```typescript
type ModelProfile = 'fast' | 'accurate' | 'judge'

function modelFor(profile: ModelProfile) {
  if (profile === 'judge') {
    return openai('gpt-5-mini', { reasoning: { effort: 'medium' } })
  }
  if (profile === 'accurate') {
    return gemini('gemini-3-flash-preview', {
      thinkingConfig: { thinkingBudget: 4096 },
    })
  }
  return openai('gpt-5-mini', { reasoning: { effort: 'low' } })
}
```

Keep profile names domain-level and stable. Provider/model IDs and provider-specific knobs should live in one module, with environment resolution kept near that factory.

## Retry And Error Handling

Use provider `retry` for provider SDK retry knobs when available. Use ADK error handlers for runnable-level recovery policy:

```typescript
import { rateLimitHandler, retryHandler, timeoutHandler } from '@animahealth/adk'

const app = adk({
  schema,
  errorHandlers: [
    rateLimitHandler({ maxRetries: 4 }),
    timeoutHandler({ fallbackResult: { recoverable: false } }),
    retryHandler({ maxAttempts: 2 }),
  ],
})
```

Prefer app-level handlers for package-wide policies and agent/call-site handlers only for narrower exceptions. Keep domain-specific validation retries, such as repetition or contract checks, in deterministic steps around the agent so the retry reason is visible in events.

## Memory Imports

Prefer subpath imports for optional providers:

```typescript
import { memory, inMemoryIndex, pgvector, sqliteVec } from '@animahealth/adk'
import { voyage } from '@animahealth/adk/voyage'
import { qdrant } from '@animahealth/adk/qdrant'
```

Current vector indexes are `inMemoryIndex()`, `qdrant()`, `pgvector()`, and `sqliteVec({ path })` (optional `better-sqlite3` + `sqlite-vec` peers; `':memory:'` for ephemeral). The pre-0.5.20 `sqliteIndex()` name is retired — `sqliteVec` is its successor.

## Memory Factory

```typescript
const requests = memory({
  model: voyage('voyage-4', { dimensions: 1024 }),
  index: qdrant({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY }),
  collection: 'requests',
  variants: ['questionnaire'],
  metadata: z.object({
    org: z.string(),
    status: z.enum(['open', 'closed']),
  }),
})
```

Options:

- `model`: `EmbeddingModel`, or asymmetric `{ index, query }`.
- `index`: `VectorIndex`, `QdrantConfig`, or `PgVectorConfig`.
- `collection`: collection/table name.
- `variants`: named vector variants, defaulting to `['default']`.
- `metadata`: optional Zod schema that validates writes and types reads.
- `slices`: heterogeneous collection shapes with distinct metadata schemas.

## Operations

Use `search()` for retrieval; it returns matches and the embedding. Forward that embedding when deferred writes should avoid re-embedding.

Other operations:

- `upsert(item | item[])`
- `updateMetadata(id, patch)`; set a key to `null` to delete metadata.
- `get(ids)`
- `delete(ids)`
- `deleteByFilter(filter)`
- `scroll({ limit, offset })`
- `count({ filter? })`
- `sample(n, options?)`
- `close()`

`search()` supports `topK`, `minScore`, `contains`, and structured filters.

`sample()` performs density-weighted diversity sampling and can be query-guided with `pool` and `gravity`.

## Filters

Flat shorthand `{ org: 'org-1', status: 'open' }` means all keys must match. Full syntax supports `must`, `should`, and `must_not` arrays.

Condition types:

- `{ key, match: { value } }`
- `{ key, text: { contains } }`
- `{ key, range: { gt, gte, lt, lte } }`

## Context And Tool Integration

`mem.context()` creates deterministic recall before reasoning. `mem.tool()` creates agent-driven recall.

```typescript
context: [
  app.context.system('Use recalled examples.'),
  requests.context({
    query: (ctx) => ctx.state.questionnaire,
    topK: 20,
    filter: (ctx) => ({ org: ctx.state.orgId }),
  }),
  app.context.history(),
]
```

## Variants And Slices

Use variants for multiple semantic views of the same entity:

```typescript
await requests.variant.questionnaire.upsert({ id, content, metadata })
await requests.variant.questionnaire.returning('full').search('rash')
```

Use slices for heterogeneous entity types:

```typescript
const records = memory({
  model,
  index,
  collection: 'patient-records',
  slices: {
    medication: { metadata: medicationSchema },
    problem: { metadata: problemSchema },
  },
})
```

Cross-slice search returns a discriminated union; `records.slices(['medication'])` narrows the result type.

## Provisioning

Qdrant collections are provisioned outside runtime code. Use `collectionSpec()` to compute vector names, dimensions, text indexes, and payload indexes.

`pgvector()` auto-provisions tables and indexes; so does `sqliteVec()` (a local file, no server). `inMemoryIndex()` needs no provisioning and is useful for tests.

`voyage()` supports optional SageMaker fallback via `sagemaker: { endpointName, region }`. Set `VOYAGE_API_KEY` or pass `apiKey`.
