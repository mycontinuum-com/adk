# Providers And Memory

Use this reference for model providers, provider profiles/options, provider auth, retry/error handling, pricing-sensitive options, vector memory, collection provisioning, and embeddings.

## Provider Imports

Prefer subpath imports so optional peer dependencies stay optional:

```typescript
import { openai } from '@animahealth/adk/openai'
import { gemini } from '@animahealth/adk/gemini'
import { claude } from '@animahealth/adk/claude'
```

The main entry still re-exports these for compatibility, but the source marks those re-exports deprecated.

## OpenAI

```typescript
openai('gpt-5-mini', {
  temperature: 0.7,
  reasoning: { effort: 'low' },
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

## Shared Model Options

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
