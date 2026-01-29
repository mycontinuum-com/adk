/**
 * Content Creation Pipeline
 *
 * A comprehensive example demonstrating all ADK orchestration mechanisms
 * working together in a realistic content production workflow.
 *
 * Architecture:
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │                        CONTENT PIPELINE                               │
 * │  ┌─────────────────────────────────────────────────────────────────┐  │
 * │  │               RESEARCH PHASE (parallel)                         │  │
 * │  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │  │
 * │  │  │ fact_finder │ │trend_analyst│ │ competitor  │                │  │
 * │  │  │             │ │             │ │  _scanner   │                │  │
 * │  │  └─────────────┘ └─────────────┘ └─────────────┘                │  │
 * │  └─────────────────────────────────────────────────────────────────┘  │
 * │                              ↓                                        │
 * │  ┌─────────────────────────────────────────────────────────────────┐  │
 * │  │               PLANNING PHASE (sequence)                         │  │
 * │  │  ┌─────────────┐ → ┌─────────────┐                              │  │
 * │  │  │  strategist │   │seo_optimizer│                              │  │
 * │  │  └─────────────┘   └─────────────┘                              │  │
 * │  └─────────────────────────────────────────────────────────────────┘  │
 * │                              ↓                                        │
 * │  ┌─────────────────────────────────────────────────────────────────┐  │
 * │  │               WRITING PHASE (loop)                              │  │
 * │  │  ┌─────────────────────────────────────────────────┐            │  │
 * │  │  │           WRITE-EDIT CYCLE (sequence)           │ ← repeat   │  │
 * │  │  │  ┌─────────────┐ → ┌─────────────┐              │   until    │  │
 * │  │  │  │   writer    │   │   editor    │              │   quality  │  │
 * │  │  │  └─────────────┘   └─────────────┘              │   met      │  │
 * │  │  └─────────────────────────────────────────────────┘            │  │
 * │  └─────────────────────────────────────────────────────────────────┘  │
 * │                              ↓                                        │
 * │  ┌─────────────────────────────────────────────────────────────────┐  │
 * │  │               APPROVAL PHASE (yield)                            │  │
 * │  │  ┌─────────────┐                                                │  │
 * │  │  │  publisher  │ → awaits human approval                        │  │
 * │  │  └─────────────┘                                                │  │
 * │  └─────────────────────────────────────────────────────────────────┘  │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Demonstrates:
 * - Parallel execution for independent research tasks
 * - Sequential flow for dependent planning stages
 * - Loop with quality-based termination condition
 * - Yielding tools for human-in-the-loop approval
 * - State management via output schemas
 * - Different context scopes (current, ancestors, all)
 *
 * Run: npx tsx examples/staticFlow.ts
 */

import { z } from 'zod';
import {
  agent,
  tool,
  sequence,
  parallel,
  loop,
  openai,
  message,
  output,
  injectSystemMessage,
  includeHistory,
  type LoopContext,
  gemini,
  type StateSchema,
} from '@anima/adk';
import { cli } from '@anima/adk/cli';

const MAX_REVISIONS = 3;
const QUALITY_THRESHOLD = 8;

const FindingsSchema = z.object({
  findings: z.string(),
});

const OutlineSchema = z.object({
  headline: z.string(),
  hook: z.string(),
  sections: z.array(
    z.object({
      title: z.string(),
      keyPoints: z.array(z.string()),
    }),
  ),
  callToAction: z.string(),
});

const SeoEnhancedOutlineSchema = z.object({
  outline: OutlineSchema,
  seo: z.object({
    primaryKeyword: z.string(),
    secondaryKeywords: z.array(z.string()),
    metaDescription: z.string(),
    internalLinkingOpportunities: z.array(z.string()),
    headingStructure: z.object({
      h1: z.string(),
      h2s: z.array(z.string()),
    }),
  }),
});

const EditorDecisionSchema = z.object({
  decision: z.enum(['approve', 'revise']),
  qualityScore: z.number().min(1).max(10),
  summary: z
    .string()
    .nullable()
    .describe('Brief summary of what makes this draft ready (when approving)'),
  feedback: z
    .string()
    .nullable()
    .describe('Specific, actionable feedback for improvement (when revising)'),
});

type EditorDecision = z.infer<typeof EditorDecisionSchema>;

const stateSchema = {
  session: {
    facts: FindingsSchema,
    trends: FindingsSchema,
    competitors: FindingsSchema,
    outline: OutlineSchema,
    seoEnhanced: SeoEnhancedOutlineSchema,
    draft: z.string(),
    editorDecision: EditorDecisionSchema,
  },
} satisfies StateSchema;

const factFinder = agent({
  name: 'fact_finder',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(`You are a fact-finding researcher.

Given a topic, identify 3-5 key facts, statistics, or data points that would strengthen a blog post.
Focus on:
- Recent statistics (cite hypothetical but realistic sources)
- Expert opinions or quotes
- Historical context

Be concise - bullet points are ideal.
Respond with JSON containing your findings.`),
    includeHistory({ scope: 'invocation' }),
  ],
  output: output(stateSchema, 'facts'),
});

const trendAnalyst = agent({
  name: 'trend_analyst',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(`You are a trend analyst specializing in content strategy.

Analyze the given topic and identify:
- Current trends related to this topic
- Audience interests and pain points
- Recommended angle or hook for the content

Be specific and actionable.
Respond with JSON containing your findings.`),
    includeHistory({ scope: 'invocation' }),
  ],
  output: output(stateSchema, 'trends'),
});

const competitorScanner = agent({
  name: 'competitor_scanner',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(`You are a competitive content analyst.

For the given topic, identify:
- What similar content typically covers
- Gaps in existing content
- Opportunities to differentiate

Focus on actionable insights.
Respond with JSON containing your findings.`),
    includeHistory({ scope: 'invocation' }),
  ],
  output: output(stateSchema, 'competitors'),
});

const researchPhase = parallel({
  name: 'research_phase',
  runnables: [factFinder, trendAnalyst, competitorScanner],
  minSuccessful: 2,
});

const strategistPrompt = message(
  stateSchema,
  (ctx) => `You are a content strategist creating a blog post outline.

<research-findings>
<facts>
${ctx.state.facts?.findings ?? '(pending)'}
</facts>
<trends>
${ctx.state.trends?.findings ?? '(pending)'}
</trends>
<competitors>
${ctx.state.competitors?.findings ?? '(pending)'}
</competitors>
</research-findings>

Create a detailed outline with:
1. Compelling headline
2. Hook/introduction approach
3. 3-5 main sections with key points for each
4. Call to action

Respond with JSON matching the output schema.`,
);

const strategist = agent({
  name: 'strategist',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(strategistPrompt),
    includeHistory({ scope: 'ancestors' }),
  ],
  output: output(stateSchema, 'outline'),
});

const seoPrompt = message(
  stateSchema,
  (ctx) => `You are an SEO specialist optimizing content strategy.

Current outline: ${JSON.stringify(ctx.state.outline, null, 2) ?? '(pending)'}

Enhance the outline with:
- Primary and secondary keywords (3-5 total)
- Meta description suggestion
- Internal linking opportunities
- Heading optimization (H1, H2, H3 structure)

Respond with JSON containing both the enhanced outline and SEO recommendations.`,
);

const seoOptimizer = agent({
  name: 'seo_optimizer',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(seoPrompt),
    includeHistory({ scope: 'ancestors' }),
  ],
  output: output(stateSchema, 'seoEnhanced'),
});

const planningPhase = sequence({
  name: 'planning_phase',
  runnables: [strategist, seoOptimizer],
});

const writerPrompt = message(
  stateSchema,
  (ctx) => `You are a skilled content writer.

<outline>
${JSON.stringify(ctx.state.seoEnhanced, null, 2) ?? '(none yet)'}
</outline>
<previous-draft>
${ctx.state.draft ?? '(none yet)'}
</previous-draft>
<editor-feedback>
${ctx.state.editorDecision?.feedback ?? '(none yet)'}
</editor-feedback>

Write or revise the blog post following the outline.
If there's editor feedback, address each point.
If this is a first draft, write engaging content that matches the outline.

Requirements:
- Match the tone to the topic
- Incorporate keywords naturally
- Keep paragraphs short and scannable
- Include a clear call to action

Respond with the full draft and no other text.`,
);

const writer = agent({
  name: 'writer',
  model: openai('gpt-4o-mini'),
  context: [
    injectSystemMessage(writerPrompt),
    includeHistory({ scope: 'ancestors' }),
  ],
  output: output(stateSchema, 'draft'),
});

const editorPrompt = message(
  stateSchema,
  (ctx) => `You are a senior content editor evaluating a draft.

Current draft: ${ctx.state.draft ?? '(none)'}

Score the draft 1-10 on: clarity, engagement, SEO, and call-to-action.
Calculate the average as the overall quality score.

Respond with JSON:
- If score >= ${QUALITY_THRESHOLD}: { "decision": "approve", "qualityScore": N, "summary": "..." }
- If score < ${QUALITY_THRESHOLD}: { "decision": "revise", "qualityScore": N, "feedback": "..." }`,
);

const editor = agent<EditorDecision>({
  name: 'editor',
  model: openai('gpt-4o-mini'),
  context: [injectSystemMessage(editorPrompt)],
  output: output(stateSchema, 'editorDecision'),
});

const writeEditCycle = sequence({
  name: 'write_edit_cycle',
  runnables: [writer, editor],
});

const writingPhase = loop({
  name: 'writing_phase',
  runnable: writeEditCycle,
  maxIterations: MAX_REVISIONS,
  while: (ctx: LoopContext) => {
    const decision = ctx.state.get<EditorDecision>('editorDecision');
    return decision?.decision !== 'approve';
  },
});

const publisherPrompt = message(
  stateSchema,
  (ctx) => `You are the publication manager finalizing content.

Final draft: ${ctx.state.draft ?? '(none)'}
Quality score: ${ctx.state.editorDecision?.qualityScore ?? '(none)'}
Editor summary: ${ctx.state.editorDecision?.summary ?? '(none)'}

Prepare the content for publication:
1. Summarize the article (2-3 sentences)
2. Suggest publication timing
3. Recommend promotion channels

Then use request_publication to submit for human approval.`,
);

const publisher = agent({
  name: 'publisher',
  model: openai('gpt-4o-mini'),
  context: [injectSystemMessage(publisherPrompt)],
  tools: [
    tool({
      name: 'request_publication',
      description:
        'Submit the content for final human approval before publishing',
      schema: z.object({
        headline: z.string(),
        summary: z.string(),
        recommendedTime: z.string(),
        channels: z.array(z.string()),
      }),
      yieldSchema: z.object({
        approved: z.boolean(),
      }),
      execute: (ctx) => ({
        status: ctx.input?.approved ? 'approved' : 'pending',
        headline: ctx.args.headline,
        summary: ctx.args.summary,
        scheduledFor: ctx.args.recommendedTime,
        promotionChannels: ctx.args.channels,
      }),
    }),
  ],
});

const contentPipeline = sequence({
  name: 'content_pipeline',
  runnables: [researchPhase, planningPhase, writingPhase, publisher],
});

cli(
  contentPipeline,
  'Write a blog post about the benefits of TypeScript for large-scale applications',
);
