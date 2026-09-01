---
name: adk
description: Use whenever work touches the ADK (@animahealth/adk) — its agents, runnables, tools, sessions, memory, voice, MCP, hooks, evals, providers, executors, knowledge, or examples.
---

# ADK

Use this skill before changing or consuming the ADK package (`@animahealth/adk`).

The ADK is Anima's TypeScript framework for production multi-agent systems. It is schema-first, event-sourced, provider-agnostic, and intentionally pre-1.0: prefer one clear API over compatibility aliases.

## Canonical Build Path

Use this path for new ADK packages and refactors unless a reference explicitly says otherwise:

1. Define the app and Zod state schema first with `adk({ name, schema })`.
2. Add app-bound tools, steps, agents, context renderers, hooks, handlers, and evals through `app.*`.
3. Run deterministic orchestration with `app.step`, `app.sequence`, `app.parallel`, or `app.loop`; keep model calls inside `app.agent`.
4. Use sessions, state, events, and artifacts as provenance. Treat rendered context as an input projection only.
5. Prove behavior with `app.test`, `runTest`, or `app.evaluate` before adding bespoke runners.

## Working Rules

- Prefer `adk({ schema })` and app-bound factories (`app.agent`, `app.tool`, `app.context.*`, `app.handler.*`, `app.evaluate.*`) for application code.
- Keep the event ledger as the source of truth. Do not infer state from rendered model context.
- Keep context rendering explicit: an agent only sees what its `context` array renders.
- Prefer structured output schemas over ad hoc JSON parsing. Use ADK parser/coercion utilities only when repairing model output is unavoidable.
- Use ADK stream events for observability. Inspect `model_start` and `model_end` for rendered context, tools, schemas, usage, cost, duration, and provider finish metadata.
- Use multimodal input through `input.message.media` or `session.input.message({ text, media })`; do not bypass ADK providers for vision calls.
- Prefer subpath imports for providers and optional integrations (complete list: `references/advanced-surfaces.md` §Export Hygiene).
- Keep npm auth, installation, publishing, and token security details in `README.md`; do not duplicate them into the skill.
- Before changing public API, inspect `src/index.ts`, `package.json` exports, and the relevant source module.
- When the README, examples, and skill disagree, prefer live exports plus the current skill. Some README/example snippets are package-consumer or legacy references.

## Anti-Patterns

- Do not wrap ADK as a raw model SDK. Model/provider calls belong behind `app.agent`; deterministic logic belongs in steps/tools.
- Do not duplicate `app.evaluate` runners unless ADK cannot express a concrete requirement.
- Do not infer durable state from rendered context, prompt text, or transcript snippets.
- Do not parse model JSON with string slicing or regex (see Working Rules for the structured-output/parser-utility guidance).

## Reference Manifest

Read only the domain documents needed for the task:

- [runnables.md](references/runnables.md): app/schema-first construction, agents, tools, steps, sequence, parallel, loop, orchestration, running, streaming, structured output, multimodal input.
- [context-sessions.md](references/context-sessions.md): context renderers, typed prompts, session/state model, stores, yield/resume, artifacts/provenance, time travel.
- [providers-memory.md](references/providers-memory.md): OpenAI/Gemini/Claude providers, provider profiles/options, authentication, retry/error handling, vector memory, Qdrant, pgvector, Voyage.
- [handlers-voice-mcp.md](references/handlers-voice-mcp.md): turn/REST/AG-UI/voice handlers, MCP, stream events, CLI, web tools.
- [hooks-errors-testing.md](references/hooks-errors-testing.md): hooks, error handlers, `app.test`, `runTest`, evals, voice evals, reports, matchers.
- [advanced-surfaces.md](references/advanced-surfaces.md): artifacts, executors, coding agents, knowledge, parsers, gateway/process stores, AG-UI adapter, package layout and export hygiene.
- [batch-eval-packages.md](references/batch-eval-packages.md): recipe for production batch eval packages, with local references from transcription, redaction, questionnaire, and patient-request evals.

## Local Example Pointers

Prefer current local examples over stale memory or external snippets — see [examples/README.md](../../../examples/README.md).

## Validation

- For ADK source changes, run the smallest relevant package command from the ADK package root first, then broaden if the change crosses domains:
  - `pnpm run test -- <path-or-pattern>`
  - `pnpm run typecheck`
  - `pnpm run build`
- If this skill changes, render the harness through the current renderer and spot-check `.agents/skills/adk/SKILL.md`.
