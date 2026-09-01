/**
 * Content Creation Pipeline
 *
 * A comprehensive example demonstrating all ADK orchestration mechanisms working together in a
 * realistic content production workflow.
 *
 * Architecture: ┌───────────────────────────────────────────────────────────────────────┐ │ CONTENT
 * PIPELINE │ │ ┌─────────────────────────────────────────────────────────────────┐ │ │ │ RESEARCH
 * PHASE (parallel) │ │ │ │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │ │ │ │ │ fact_finder │
 * │trend_analyst│ │ competitor │ │ │ │ │ │ │ │ │ │ _scanner │ │ │ │ │ └─────────────┘
 * └─────────────┘ └─────────────┘ │ │ │
 * └─────────────────────────────────────────────────────────────────┘ │ │ ↓ │ │
 * ┌─────────────────────────────────────────────────────────────────┐ │ │ │ PLANNING PHASE
 * (sequence) │ │ │ │ ┌─────────────┐ → ┌─────────────┐ │ │ │ │ │ strategist │ │seo_optimizer│ │ │ │
 * │ └─────────────┘ └─────────────┘ │ │ │
 * └─────────────────────────────────────────────────────────────────┘ │ │ ↓ │ │
 * ┌─────────────────────────────────────────────────────────────────┐ │ │ │ WRITING PHASE (loop) │
 * │ │ │ ┌─────────────────────────────────────────────────┐ │ │ │ │ │ WRITE-EDIT CYCLE (sequence) │
 * ← repeat │ │ │ │ │ ┌─────────────┐ → ┌─────────────┐ │ until │ │ │ │ │ │ writer │ │ editor │ │
 * quality │ │ │ │ │ └─────────────┘ └─────────────┘ │ met │ │ │ │
 * └─────────────────────────────────────────────────┘ │ │ │
 * └─────────────────────────────────────────────────────────────────┘ │ │ ↓ │ │
 * ┌─────────────────────────────────────────────────────────────────┐ │ │ │ APPROVAL PHASE (yield)
 * │ │ │ │ ┌─────────────┐ │ │ │ │ │ publisher │ → awaits human approval │ │ │ │ └─────────────┘ │ │
 * │ └─────────────────────────────────────────────────────────────────┘ │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Demonstrates:
 *
 * - Parallel execution for independent research tasks
 * - Sequential flow for dependent planning stages
 * - Loop with quality-based termination condition
 * - Yielding tools for human-in-the-loop approval
 * - State management via output schemas
 * - Different context scopes (current, ancestors, all)
 *
 * Run: npx tsx examples/staticFlow.ts
 */

import { z } from 'zod'

import { adk, type StateSchema } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const MAX_REVISIONS = 3
const QUALITY_THRESHOLD = 8

const FindingsSchema = z.object({
  findings: z.string(),
})

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
})

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
})

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
})

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
} satisfies StateSchema

const app = adk({ schema: stateSchema })

const factFinder = app.agent({
  name: 'fact_finder',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(`You are a fact-finding researcher.

Given a topic, identify 3-5 key facts, statistics, or data points that would strengthen a blog post.
Focus on:
- Recent statistics (cite hypothetical but realistic sources)
- Expert opinions or quotes
- Historical context

Be concise - bullet points are ideal.
Respond with JSON containing your findings.`),
    app.context.history({ scope: 'invocation' }),
  ],
  output: 'facts',
})

const trendAnalyst = app.agent({
  name: 'trend_analyst',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(`You are a trend analyst specializing in content strategy.

Analyze the given topic and identify:
- Current trends related to this topic
- Audience interests and pain points
- Recommended angle or hook for the content

Be specific and actionable.
Respond with JSON containing your findings.`),
    app.context.history({ scope: 'invocation' }),
  ],
  output: 'trends',
})

const competitorScanner = app.agent({
  name: 'competitor_scanner',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(`You are a competitive content analyst.

For the given topic, identify:
- What similar content typically covers
- Gaps in existing content
- Opportunities to differentiate

Focus on actionable insights.
Respond with JSON containing your findings.`),
    app.context.history({ scope: 'invocation' }),
  ],
  output: 'competitors',
})

const researchPhase = app.parallel({
  name: 'research_phase',
  runnables: [factFinder, trendAnalyst, competitorScanner],
  minSuccessful: 2,
})

const strategist = app.agent({
  name: 'strategist',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
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
    ),
    app.context.history({ scope: 'ancestors' }),
  ],
  output: 'outline',
})

const seoOptimizer = app.agent({
  name: 'seo_optimizer',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      (ctx) => `You are an SEO specialist optimizing content strategy.

Current outline: ${JSON.stringify(ctx.state.outline, null, 2) ?? '(pending)'}

Enhance the outline with:
- Primary and secondary keywords (3-5 total)
- Meta description suggestion
- Internal linking opportunities
- Heading optimization (H1, H2, H3 structure)

Respond with JSON containing both the enhanced outline and SEO recommendations.`,
    ),
    app.context.history({ scope: 'ancestors' }),
  ],
  output: 'seoEnhanced',
})

const planningPhase = app.sequence({
  name: 'planning_phase',
  runnables: [strategist, seoOptimizer],
})

const writer = app.agent({
  name: 'writer',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
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
    ),
    app.context.history({ scope: 'ancestors' }),
  ],
  output: 'draft',
})

const editor = app.agent({
  name: 'editor',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      (ctx) => `You are a senior content editor evaluating a draft.

Current draft: ${ctx.state.draft ?? '(none)'}

Score the draft 1-10 on: clarity, engagement, SEO, and call-to-action.
Calculate the average as the overall quality score.

Respond with JSON:
- If score >= ${QUALITY_THRESHOLD}: { "decision": "approve", "qualityScore": N, "summary": "..." }
- If score < ${QUALITY_THRESHOLD}: { "decision": "revise", "qualityScore": N, "feedback": "..." }`,
    ),
  ],
  output: 'editorDecision',
})

const writeEditCycle = app.sequence({
  name: 'write_edit_cycle',
  runnables: [writer, editor],
})

const writingPhase = app.loop({
  name: 'writing_phase',
  runnable: writeEditCycle,
  maxIterations: MAX_REVISIONS,
  while: (ctx) => {
    const decision = ctx.state.editorDecision
    return decision?.decision !== 'approve'
  },
})

const publisher = app.agent({
  name: 'publisher',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(
      (ctx) => `You are the publication manager finalizing content.

Final draft: ${ctx.state.draft ?? '(none)'}
Quality score: ${ctx.state.editorDecision?.qualityScore ?? '(none)'}
Editor summary: ${ctx.state.editorDecision?.summary ?? '(none)'}

Prepare the content for publication:
1. Summarize the article (2-3 sentences)
2. Suggest publication timing
3. Recommend promotion channels

Then use request_publication to submit for human approval.`,
    ),
  ],
  tools: [
    app.tool({
      name: 'request_publication',
      description: 'Submit the content for final human approval before publishing',
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
})

const contentPipeline = app.sequence({
  name: 'content_pipeline',
  runnables: [researchPhase, planningPhase, writingPhase, publisher],
})

app.cli(
  contentPipeline,
  'Write a blog post about the benefits of TypeScript for large-scale applications',
)
