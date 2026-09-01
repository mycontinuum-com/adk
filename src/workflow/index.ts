/**
 * @animahealth/adk/workflow
 *
 *   Optional CC-compatible workflow-file loader. This is the ONLY subpath that carries CC
 *   vocabulary (runWorkflowFile, TierModelMap, NodeRunner). The ADK core does NOT import this
 *   subpath. This subpath MAY import from the core (app.ask, fanout, AnnotationEvent, ctx.note),
 *   and from ./agents/coding. Nothing in the core imports this subpath. v1 scope: meta / agent /
 *   parallel / phase / log + JSON-Schema + tier map. Deferred CC features (pipeline, args, budget,
 *   nested workflow(), isolation, agentType, retries, timeoutMs) raise a clear 'unsupported CC
 *   feature' error naming the specific feature.
 */

import * as fs from 'node:fs'
import { runInNewContext } from 'node:vm'

import type { AdkApp } from '../api/app'
import type { ModelConfig, StepContext } from '../types/runnables'
import type { RunResult } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { CCAgentOpts, NodeRunner, TierModelMap } from './types'

import { fanout } from '../agents/fanout'
import { jsonSchemaToZod } from './schema'

export type { TierModelMap, NodeRunner, CCAgentOpts } from './types'

/**
 * Parsed `meta` block of a CC workflow file. Read STATICALLY (without executing the body) so a host
 * can display/index a workflow without running arbitrary code. MUST be a pure literal.
 */
export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

export interface RunWorkflowFileOptions {
  /** The ADK app instance used to construct agents and run the workflow. */
  app: AdkApp<StateSchema>
  /** Tier-to-ModelConfig map. Required. Fails fast on unmapped tier or missing credential. */
  models: TierModelMap
  /**
   * Node runner. Defaults to app.ask when omitted (no-tools isolated LLM call). Supply a coding
   * node runner for build attractors whose agent() calls mutate files.
   */
  node?: NodeRunner
}

/**
 * The eight deferred CC features each raise a clear, feature-naming error:
 *
 * - Agent() OPTIONS: isolation, agentType, retries, timeoutMs (DEFERRED_AGENT_OPTIONS below).
 * - GLOBALS: pipeline, nested workflow(), and the args / budget accessor globals (trapped inline in
 *   runWorkflowFile via deferredGlobal / makeDeferredAccessProxy).
 */
const DEFERRED_AGENT_OPTIONS = ['isolation', 'agentType', 'retries', 'timeoutMs'] as const

/** Recognized (required-subset) CC agent() option keys; everything else is rejected. */
const RECOGNIZED_AGENT_OPTIONS = new Set(['label', 'phase', 'model', 'schema'])

/** Error thrown for a deferred / unsupported CC feature. Names the specific triggering feature. */
export class UnsupportedCCFeatureError extends Error {
  constructor(public readonly feature: string) {
    super(
      `unsupported CC feature: '${feature}' is deferred to a later loader version (v1 supports meta / agent / parallel / phase / log + JSON-Schema + opus/sonnet tiers).`,
    )
    this.name = 'UnsupportedCCFeatureError'
  }
}

/** Error thrown when a CC file selects a model tier the loader's map does not define. */
export class UnmappedTierError extends Error {
  constructor(tier: string, definedTiers: string[]) {
    super(
      `unmapped model tier '${tier}': the loader's tier map defines [${definedTiers.join(', ')}] (plus a default for an omitted model). No substitution is performed — add '${tier}' to the tier map.`,
    )
    this.name = 'UnmappedTierError'
  }
}

/** Error thrown when a CC file's `meta` is not a statically-analyzable pure literal. */
export class NonLiteralMetaError extends Error {
  constructor(detail: string) {
    super(
      `CC workflow meta must be a pure object literal readable without executing the body: ${detail}`,
    )
    this.name = 'NonLiteralMetaError'
  }
}

/**
 * Extract the source text of the `export const meta = <expr>` initializer by brace-matching from
 * the `meta` declaration. Returns the expression text (e.g. `{ name: '...', ... }`).
 */
function extractMetaExpressionSource(source: string): string {
  const decl = /export\s+const\s+meta\s*=\s*/.exec(source)
  if (!decl) {
    throw new NonLiteralMetaError('no `export const meta = { ... }` declaration found')
  }
  let i = decl.index + decl[0].length
  // Skip whitespace.
  while (i < source.length && /\s/.test(source[i])) i++
  if (source[i] !== '{') {
    throw new NonLiteralMetaError('meta initializer is not an object literal')
  }
  // Brace-match, honoring strings so a `}` inside a string does not close the object.
  let depth = 0
  let inString: string | null = null
  const start = i
  for (; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (ch === '\\') {
        i++ // skip escaped char
        continue
      }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  throw new NonLiteralMetaError('unbalanced braces in meta initializer')
}

/**
 * Parse a CC workflow file's `meta` STATICALLY: evaluate ONLY the object-literal initializer in an
 * empty VM sandbox. A pure literal evaluates cleanly; a computed initializer (e.g. `{ name }`
 * referencing a module const, or a function/template call) throws a ReferenceError/other error and
 * is rejected as non-literal. The body is NEVER executed.
 */
export function parseWorkflowMeta(source: string): WorkflowMeta {
  const exprSource = extractMetaExpressionSource(source)
  let value: unknown
  try {
    // Empty sandbox: any identifier reference (computed meta) throws ReferenceError.
    // `Object.freeze` of the global is implicit — we pass no bindings at all.
    value = runInNewContext(`(${exprSource})`, Object.create(null), {
      timeout: 1000,
      filename: 'meta.literal.js',
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new NonLiteralMetaError(
      `evaluating the literal failed (likely a computed value): ${reason}`,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NonLiteralMetaError('meta must be an object literal')
  }
  const meta = value as Record<string, unknown>
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') {
    throw new NonLiteralMetaError('meta.name and meta.description are required string fields')
  }
  const parsed: WorkflowMeta = {
    name: meta.name,
    description: meta.description,
  }
  if (typeof meta.whenToUse === 'string') parsed.whenToUse = meta.whenToUse
  if (Array.isArray(meta.phases)) {
    parsed.phases = meta.phases.map((p) => {
      const phase = p as Record<string, unknown>
      const out: { title: string; detail?: string; model?: string } = {
        title: typeof phase.title === 'string' ? phase.title : '',
      }
      if (typeof phase.detail === 'string') out.detail = phase.detail
      if (typeof phase.model === 'string') out.model = phase.model
      return out
    })
  }
  return parsed
}

/**
 * Resolve a CC `model` tier string to a concrete ModelConfig through the tier map.
 *
 * - An OMITTED model uses `models.default`.
 * - A PRESENT-but-unmapped tier is an error naming the tier and the defined tiers (no substitution,
 *   no fallback-to-default).
 */
function resolveTierModel(models: TierModelMap, tier: string | undefined): ModelConfig {
  if (tier === undefined) {
    return models.default
  }
  const mapped = models.byTier[tier]
  if (!mapped) {
    throw new UnmappedTierError(tier, Object.keys(models.byTier))
  }
  return mapped
}

/**
 * Validate the CC agent() options: accept the required subset (label/phase/model/schema), reject
 * each deferred option NAMING it. Returns the recognized options.
 */
function validateAgentOpts(opts: CCAgentOpts | undefined): CCAgentOpts {
  if (!opts) return {}
  for (const deferred of DEFERRED_AGENT_OPTIONS) {
    if (opts[deferred] !== undefined) {
      throw new UnsupportedCCFeatureError(deferred)
    }
  }
  // Any unrecognized key is also rejected, naming it, rather than silently ignored.
  for (const key of Object.keys(opts)) {
    if (
      !RECOGNIZED_AGENT_OPTIONS.has(key) &&
      !(DEFERRED_AGENT_OPTIONS as readonly string[]).includes(key)
    ) {
      throw new UnsupportedCCFeatureError(key)
    }
  }
  return opts
}

/**
 * The default node runner: a no-tools, fresh-session `app.ask` call. Resolves the CC `model` tier
 * through the map, converts the JSON-Schema literal to a Zod output schema, and returns the
 * UNWRAPPED validated object (or text) on success, or `null` on failure (so the CC
 * `.filter(Boolean)` / bare null-guard idioms hold).
 */
function makeDefaultNodeRunner(app: AdkApp<StateSchema>, models: TierModelMap): NodeRunner {
  return async (prompt, opts, signal) => {
    const model = resolveTierModel(models, opts.model)
    const schema = opts.schema ? jsonSchemaToZod(opts.schema) : undefined
    try {
      if (schema) {
        return await app.ask(prompt, { model, schema, signal })
      }
      return await app.ask(prompt, { model, signal })
    } catch {
      // A loader-bound agent() resolves to null on failure (exhausted schema retries, etc.),
      // never throws out of the body — so the CC null-guard / filter(Boolean) idioms work.
      return null
    }
  }
}

/**
 * Load and run a CC-compatible workflow file as an ADK Step via app.run.
 *
 * The loader:
 *
 * 1. Reads the file's `meta` field as a pure literal (without executing the body); rejects a computed
 *    meta.
 * 2. Binds the CC globals (agent, parallel, phase, log) BEFORE the top-level body runs.
 * 3. Executes the body inside an app.step via app.run.
 * 4. Returns the RunResult (the body's return value is surfaced as RunResult.output.value).
 *
 * Bindings: agent → the node runner (default app.ask, no-tools; a coding node runner for build
 * attractors); parallel → fanout (per-thunk failure → null); phase/log → ctx.note.
 *
 * Fails fast (before any agent executes) on: a computed (non-literal) `meta`; an unmapped tier or
 * missing credential (no substitution); a deferred CC feature (pipeline, args, budget, nested
 * workflow(), isolation, agentType, retries, timeoutMs) — each NAMED; and a v2 option
 * (resume/background/runId).
 */
export async function runWorkflowFile(
  path: string,
  opts: RunWorkflowFileOptions,
): Promise<RunResult<StateSchema>> {
  const { app, models } = opts

  // ── v2 guard: resume / background / runId are deferred; reject, do not accept-and-ignore. ──────
  const optsRecord = opts as unknown as Record<string, unknown>
  for (const v2Key of ['resume', 'background', 'runId'] as const) {
    if (v2Key in optsRecord) {
      throw new Error(
        `[adk] runWorkflowFile: '${v2Key}' is deferred to v2 (durable resume / background execution on the process-runtime gateway). Remove this option or wait for v2.`,
      )
    }
  }

  // ── 1. Read the file + parse meta STATICALLY (rejects computed meta, before any execution). ────
  const source = fs.readFileSync(path, 'utf8')
  const meta = parseWorkflowMeta(source) // throws NonLiteralMetaError on a computed meta

  // ── 2. Build the CC global bindings (bound BEFORE the body executes). ──────────────────────────
  const nodeRunner: NodeRunner = opts.node ?? makeDefaultNodeRunner(app, models)

  // The body is wrapped in an async function whose params ARE the globals — so they are in scope
  // the instant the top-level body begins evaluating (no ReferenceError at module scope).
  const body = stripMetaDeclaration(source, meta)

  // The Step wraps the CC body. agent/parallel/phase/log are closed over here; the body's return
  // value is captured and surfaced via ctx.output.
  const step = app.step({
    name: meta.name,
    execute: async (ctx: StepContext<StateSchema>) => {
      // Validate tiers referenced by phases[].model fail fast too (named), before the body runs.
      if (meta.phases) {
        for (const phase of meta.phases) {
          if (phase.model !== undefined) resolveTierModel(models, phase.model)
        }
      }

      const phaseFn = (title: string): void => {
        ctx.note(title, { kind: 'phase' })
      }
      const logFn = (message: string): void => {
        ctx.note(message)
      }

      const agentFn = async (prompt: string, agentOpts?: CCAgentOpts): Promise<unknown | null> => {
        const validated = validateAgentOpts(agentOpts)
        // Resolve the tier eagerly so an unmapped tier fails fast NAMING the tier (no run started).
        resolveTierModel(models, validated.model)
        const result = await nodeRunner(prompt, validated, undefined)
        // The phase OPTION annotates this node's own metadata WITHOUT firing a second phase marker.
        // label + phase are carried as distinct fields on a node-level annotation (kind 'mark').
        if (validated.label !== undefined || validated.phase !== undefined) {
          ctx.note(`node:${validated.label ?? 'agent'}`, {
            kind: 'mark',
            label: validated.label,
            data: { phase: validated.phase },
          })
        }
        return result
      }

      const parallelFn = async (
        thunks: Array<() => Promise<unknown>>,
      ): Promise<Array<unknown | null>> => {
        return fanout(thunks)
      }

      // Deferred globals: invoking any raises a feature-naming error.
      const deferredGlobal = (name: string) => () => {
        throw new UnsupportedCCFeatureError(name)
      }

      const bodyFn = compileBody(body)
      const returnValue = await bodyFn({
        agent: agentFn,
        parallel: parallelFn,
        phase: phaseFn,
        log: logFn,
        pipeline: deferredGlobal('pipeline'),
        workflow: deferredGlobal('workflow'),
        // args / budget are accessed as objects (args.x / budget.remaining); a throwing proxy names them.
        args: makeDeferredAccessProxy('args'),
        budget: makeDeferredAccessProxy('budget'),
      })

      if (returnValue !== undefined) {
        ctx.output(returnValue)
      }
    },
  })

  const result = (await app.run(step, meta.name)) as RunResult<StateSchema>

  // A thrown error inside the CC body (an unmapped tier, a deferred CC feature, an unprovisionable
  // workspace from a coding node runner) is turned into an `error`-status RunResult by the step
  // runner — it does NOT reject app.run. The loader surfaces these as a REJECTION so the caller sees
  // the feature-naming / tier-naming validation error (recoverable per-node failures are mapped to
  // `null` inside the node runner and never reach here, so a clean run still returns its RunResult).
  if (result.status === 'error') {
    throw new Error((result as { error: string }).error)
  }

  return result
}

/** A proxy whose any access raises a feature-naming error (for the `args` / `budget` globals). */
function makeDeferredAccessProxy(name: string): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new UnsupportedCCFeatureError(name)
      },
      has() {
        throw new UnsupportedCCFeatureError(name)
      },
    },
  )
}

/** The shape of the globals injected into a compiled CC body. */
interface CCGlobals {
  agent: (prompt: string, opts?: CCAgentOpts) => Promise<unknown | null>
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<Array<unknown | null>>
  phase: (title: string) => void
  log: (message: string) => void
  pipeline: () => never
  workflow: () => never
  args: unknown
  budget: unknown
}

type CompiledBody = (globals: CCGlobals) => Promise<unknown>

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>

/**
 * Compile the CC body into an async function whose parameters are the CC globals — so the globals
 * are bound before the body's top-level statements run. Top-level `await` and `return` work because
 * the body executes as an async function body.
 */
function compileBody(body: string): CompiledBody {
  // Single destructured parameter so the globals are lexically in scope for the whole body.
  const fn = new AsyncFunction(
    '__cc__',
    `const { agent, parallel, phase, log, pipeline, workflow, args, budget } = __cc__;\n${body}`,
  )
  return (globals: CCGlobals) => fn(globals) as Promise<unknown>
}

/**
 * Remove the `export const meta = { ... }` declaration from the source (it is parsed statically and
 * is not part of the executable body), and strip any remaining `export ` keywords so the body is a
 * valid function body. The `meta` literal text is replaced with whitespace so line numbers are
 * roughly preserved.
 */
function stripMetaDeclaration(source: string, _meta: WorkflowMeta): string {
  const decl = /export\s+const\s+meta\s*=\s*/.exec(source)
  if (!decl) return source
  const exprSource = extractMetaExpressionSource(source)
  const exprStart = source.indexOf(exprSource, decl.index)
  const exprEnd = exprStart + exprSource.length
  // Drop everything from `export const meta =` through the end of the literal (+ optional `;`).
  let end = exprEnd
  while (end < source.length && /[\s;]/.test(source[end])) {
    if (source[end] === ';') {
      end++
      break
    }
    end++
  }
  const without = source.slice(0, decl.index) + source.slice(end)
  // CC files only export `meta`; strip any stray `export ` keywords defensively.
  return without.replace(/^\s*export\s+/gm, '')
}
