import type { RenderContext } from '../types/runnables'
import type { Embedder } from './types'

import { voyage } from '../integrations/voyage'
import { memory } from './memory'
import { inMemoryIndex } from './providers/inMemoryIndex'

const DIMS = 4

function semanticEmbedder(vocabulary: Record<string, number[]>): Embedder {
  return {
    dimensions: DIMS,
    modelName: 'semantic-test',
    async embed(input) {
      return {
        embeddings: input.map((text) => {
          const vec = vocabulary[text]
          if (!vec) throw new Error(`Unknown text in semantic embedder: "${text}"`)
          return vec
        }),
        model: 'semantic-test',
      }
    },
  }
}

const DOCUMENTS = {
  'req-1': {
    content: 'eczema patient with rash',
    vector: [1, 0, 0, 0] as number[],
    metadata: { org: 'acme', theme: 'skin' },
  },
  'req-2': {
    content: 'chronic dermatitis case',
    vector: [0.9, 0.44, 0, 0] as number[],
    metadata: { org: 'acme', theme: 'skin' },
  },
  'req-3': {
    content: 'migraine with aura',
    vector: [0, 0, 1, 0] as number[],
    metadata: { org: 'acme', theme: 'neuro' },
  },
  'req-4': {
    content: 'radius fracture follow-up',
    vector: [0, 0, 0, 1] as number[],
    metadata: { org: 'other', theme: 'ortho' },
  },
}

const QUERIES: Record<string, number[]> = {
  'skin condition': [0.95, 0.05, 0, 0],
  'headache symptoms': [0.05, 0, 0.95, 0],
}

function buildVocabulary(): Record<string, number[]> {
  const vocab: Record<string, number[]> = {}
  for (const doc of Object.values(DOCUMENTS)) {
    vocab[doc.content] = doc.vector
  }
  Object.assign(vocab, QUERIES)
  return vocab
}

function mockRenderContext(overrides?: Partial<RenderContext>): RenderContext {
  return {
    invocationId: 'inv-1',
    agentName: 'test-agent',
    session: {} as never,
    state: {} as never,
    agent: {} as never,
    events: [],
    functionTools: [],
    providerTools: [],
    ...overrides,
  } as unknown as RenderContext
}

describe('memory e2e', () => {
  function create(variant = 'default') {
    return memory({
      model: semanticEmbedder(buildVocabulary()),
      index: inMemoryIndex(),
      collection: 'requests',
      variants: [variant],
    })
  }

  async function seed(mem: ReturnType<typeof create>) {
    await mem.upsert(
      Object.entries(DOCUMENTS).map(([id, doc]) => ({
        id,
        content: doc.content,
        metadata: doc.metadata,
      })),
    )
  }

  describe('search ranking', () => {
    it('ranks by cosine similarity through the full pipeline', async () => {
      const mem = create()
      await seed(mem)

      const { matches } = await mem.search('skin condition', { topK: 4 })

      expect(matches[0].id).toBe('req-1')
      expect(matches[1].id).toBe('req-2')
      expect(matches[0].score).toBeGreaterThan(matches[1].score)
      expect(matches[1].score).toBeGreaterThan(matches[2].score)
    })

    it('different queries surface different top results', async () => {
      const mem = create()
      await seed(mem)

      const skin = await mem.search('skin condition', { topK: 1 })
      const neuro = await mem.search('headache symptoms', { topK: 1 })

      expect(skin.matches[0].id).toBe('req-1')
      expect(neuro.matches[0].id).toBe('req-3')
    })
  })

  describe('context renderer', () => {
    it('injects ranked matches into RenderContext events', async () => {
      const mem = create()
      await seed(mem)

      const renderer = mem.context({
        query: () => 'skin condition',
        topK: 2,
      })
      const result = await renderer(mockRenderContext())

      expect(result.events).toHaveLength(1)
      const event = result.events[0] as { type: string; text: string }
      expect(event.type).toBe('system')
      expect(event.text).toContain('id="req-1"')
      expect(event.text).toContain('id="req-2"')
      expect(event.text.indexOf('id="req-1"')).toBeLessThan(event.text.indexOf('id="req-2"'))
    })
  })

  describe('tool', () => {
    it('returns ranked matches via tool execute', async () => {
      const mem = create()
      await seed(mem)

      const tool = mem.tool({ description: 'Search requests', topK: 2 })
      const result = await tool.execute!({
        args: { query: 'skin condition' },
        state: {},
      } as never)

      const text = result as string
      expect(text).toContain('id="req-1"')
      expect(text).toContain('id="req-2"')
      expect(text.indexOf('id="req-1"')).toBeLessThan(text.indexOf('id="req-2"'))
    })
  })

  describe('filtered search', () => {
    it('applies metadata filter then ranks by similarity', async () => {
      const mem = create()
      await seed(mem)

      const { matches } = await mem.search('skin condition', {
        topK: 10,
        filter: { must: [{ key: 'theme', match: { value: 'skin' } }] },
      })

      expect(matches).toHaveLength(2)
      expect(matches[0].id).toBe('req-1')
      expect(matches[1].id).toBe('req-2')
    })
  })

  describe('variant isolation', () => {
    it('same entity returns different scores per variant', async () => {
      const vocab = buildVocabulary()
      vocab['eczema questionnaire summary'] = [1, 0, 0, 0]
      vocab['full patient history with labs and imaging'] = [0.5, 0.5, 0.5, 0.5]

      const embedder = semanticEmbedder(vocab)
      const idx = inMemoryIndex()

      const mem = memory({
        model: embedder,
        index: idx,
        collection: 'c',
        variants: ['summary', 'full'],
      })
      const summary = mem.variant.summary
      const full = mem.variant.full

      await summary.upsert({
        id: 'req-1',
        content: 'eczema questionnaire summary',
        metadata: {},
      })
      await full.upsert({
        id: 'req-1',
        content: 'full patient history with labs and imaging',
        metadata: {},
      })

      const summaryResult = await summary.search('skin condition')
      const fullResult = await full.search('skin condition')

      expect(summaryResult.matches[0].score).toBeGreaterThan(fullResult.matches[0].score)
    })
  })

  describe('sample diversity', () => {
    it('selects representatives from distinct clusters', async () => {
      const clusterVocab: Record<string, number[]> = {
        'skin-1': [1.0, 0.0, 0.0, 0.0],
        'skin-2': [0.95, 0.05, 0.0, 0.0],
        'skin-3': [0.9, 0.1, 0.0, 0.0],
        'neuro-1': [0.0, 0.0, 1.0, 0.0],
        'neuro-2': [0.0, 0.0, 0.95, 0.05],
        'neuro-3': [0.0, 0.0, 0.9, 0.1],
      }

      const mem = memory({
        model: semanticEmbedder(clusterVocab),
        index: inMemoryIndex(),
        collection: 'test',
      })

      await mem.upsert(
        Object.keys(clusterVocab).map((id) => ({
          id,
          content: id,
          metadata: {},
        })),
      )

      const result = await mem.sample(2, { pool: 6 })

      expect(result.matches).toHaveLength(2)
      const ids = result.matches.map((m) => m.id)
      const hasSkin = ids.some((id) => id.startsWith('skin-'))
      const hasNeuro = ids.some((id) => id.startsWith('neuro-'))
      expect(hasSkin).toBe(true)
      expect(hasNeuro).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Embedding eval — validates real model quality end-to-end.
// Gated behind explicit opt-in so normal test and publish runs do not call the network.
// ---------------------------------------------------------------------------

const RUN_VOYAGE_EVALS = process.env.ADK_RUN_VOYAGE_EVALS === '1' && !!process.env.VOYAGE_API_KEY

;(RUN_VOYAGE_EVALS ? describe : describe.skip)('embedding eval', () => {
  it('clinical similarity reflects medical relatedness', async () => {
    const mem = memory({
      model: voyage('voyage-4', { dimensions: 1024 }),
      index: inMemoryIndex(),
      collection: 'eval',
    })

    await mem.upsert([
      {
        id: 'eczema',
        content: 'Patient presenting with eczema on both arms, dry flaky skin with intense itching',
      },
      {
        id: 'dermatitis',
        content: 'Contact dermatitis from nickel allergy, red inflamed skin patches',
      },
      {
        id: 'psoriasis',
        content: 'Chronic plaque psoriasis on elbows and knees, silvery scales',
      },
      {
        id: 'migraine',
        content: 'Recurring migraine episodes with photophobia, nausea, and visual aura',
      },
      {
        id: 'fracture',
        content: 'Distal radius fracture from fall, needs orthopedic referral and casting',
      },
    ])

    const { matches } = await mem.search('patient with skin rash and irritation')

    const skinIds = new Set(['eczema', 'dermatitis', 'psoriasis'])
    const topTwo = matches.slice(0, 2).map((m) => m.id)
    expect(topTwo.every((id) => skinIds.has(id))).toBe(true)

    const skinAvg = matches.filter((m) => skinIds.has(m.id)).reduce((s, m) => s + m.score, 0) / 3
    const nonSkinAvg =
      matches.filter((m) => !skinIds.has(m.id)).reduce((s, m) => s + m.score, 0) / 2
    expect(skinAvg).toBeGreaterThan(nonSkinAvg)
  }, 30_000)
})
