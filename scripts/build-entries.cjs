'use strict'

// The one place a public entry point is named. `tsup.config.ts` bundles the JavaScript for these,
// and `postbuild-dts-aliases.cjs` reconciles the declarations `tsc` emits with the same names.
// Keeping both readers on one table is what stops an entry from having JavaScript but no types.

/** Bundled together, sharing the heavy dependency list. */
const MAIN_ENTRIES = {
  index: 'src/index.ts',
  'cli/index': 'src/cli/index.ts',
  'testing/index': 'src/testing/index.ts',
  'eval/index': 'src/eval/index.ts',
  'web/index': 'src/web/index.ts',
  'agui/index': 'src/agui/index.ts',
  'stores/dynamodb': 'src/session/dynamodb.ts',
  'stores/postgres': 'src/session/postgres.ts',
  'stores/sqlite': 'src/session/sqlite.ts',
  'voice/index': 'src/voice/index.ts',
}

/**
 * Each of these bundles one provider SDK in, so importing the ADK does not drag every provider
 * along. The array beside an entry is what it stops treating as external.
 */
const SUBPATH_ENTRIES = [
  [
    { 'openai/index': 'src/integrations/openai.ts' },
    ['openai', 'openai/helpers/zod', 'openai/resources/responses/responses', 'ws'],
  ],
  [{ 'gemini/index': 'src/integrations/gemini.ts' }, ['@google/genai']],
  [{ 'claude/index': 'src/integrations/claude.ts' }, ['@anthropic-ai/vertex-sdk']],
  [{ 'voyage/index': 'src/integrations/voyage.ts' }, ['voyageai']],
  [{ 'qdrant/index': 'src/integrations/qdrant.ts' }, ['@qdrant/js-client-rest']],
  [{ 'agents/coding/index': 'src/agents/coding/index.ts' }, []],
  [
    {
      'agents/coding/claude-code/index': 'src/agents/coding/claude-code/index.ts',
    },
    ['@anthropic-ai/claude-agent-sdk'],
  ],
  [{ 'workflow/index': 'src/workflow/index.ts' }, []],
]

/** Every entry, as `dist name -> source file`. */
const ALL_ENTRIES = Object.assign({}, MAIN_ENTRIES, ...SUBPATH_ENTRIES.map(([entry]) => entry))

module.exports = { MAIN_ENTRIES, SUBPATH_ENTRIES, ALL_ENTRIES }
