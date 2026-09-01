# Batch Eval Packages

Use this recipe for production batch eval packages such as document transcription, redaction, questionnaire routing, and patient-request voice evaluation.

## Canonical Shape

Build batch evals around the app, not around provider calls:

1. Define `app = adk({ name, schema })` and the smallest state shape needed by cases.
2. Implement domain behavior as app-bound agents, tools, steps, and sequences.
3. Hydrate samples outside ADK, then create one `EvalCase` per independently reviewable sample/candidate.
4. Run cases with `app.evaluate` or `app.evaluate.voice`.
5. Write deterministic reports and reviewer artifacts from the eval result, session events, and artifacts.

Custom CLI code should select samples, configure model profiles, resolve caches, show progress, and write exports. It should not reimplement eval scheduling, retries, metrics, or case execution unless the ADK eval surface cannot express a concrete requirement.

Use this directory shape when the package is large enough to need structure: `evals/env.ts`, `sample.ts`, `cases/`, `metrics/`, `reports/`, `suites/run*.ts`, generated `REPORT.md`, and optional `runs/`. Keep small packages smaller; redaction-style evals can stay at `sample`, `run`, `judge`, and `report`.

## Case Design

Each case should have:

- a stable `name` that contains the sample or candidate identifier;
- `runnable` pointing at an app-bound agent/sequence/pipeline;
- `input` with `message`, `state`, or both;
- `initialState` via `app.initialState(...)` when the case seeds shared scopes or voice setup state;
- mocked tools when external effects are not part of the eval target;
- metrics that encode pass/fail gates and evidence;
- a timeout and retry policy sized to the domain.

For document or multimodal suites, pass page/document media through `input.message.media`; do not call provider SDKs directly for image inputs.

For voice suites, use `app.evaluate.voice.case`, `app.evaluate.voice.cases`, `app.evaluate.voice`, and `app.evaluate.voice.report` so recordings, transcripts, timings, events, usage, and case output share one result shape.

Use `toolMocks` for tool execution and state effects. Use `toolAgents` for yielded user/tool responses. Do not collapse those roles into one abstraction.

## Metrics And Reports

Use metrics for objective gates, not report-only checks. A metric should return `passed`, optional `score`, and concise `evidence` that can be rendered in reports and debug output.

Use reports in two layers when needed:

- ADK suite report for pass/fail/errors, metric evidence, timings, and case details.
- Domain report for aggregate tables, candidate deltas, reviewer links, costs, and excerpts.

Hard gates belong in metrics or deterministic post-processing of the suite result. CI-blocking evals must explicitly fail on metric failures; some local runners treat metric failures as measurement output unless post-processed. Do not rerun cases just to build a report.

## Cache, Resume, And Artifacts

Keep cache keys deterministic and domain-level, for example sample ID + candidate profile + prompt/config hash. Store only reusable, non-ambiguous outputs in cache.

For resumable evals:

- decide the run directory and case bundle before execution;
- read existing complete case artifacts before scheduling new cases;
- write case exports atomically where possible;
- keep PHI-sensitive output permissions explicit when writing local files;
- use sessions/events/artifact updates as provenance and filesystem files as reviewer exports.

Do not infer resume state from rendered prompts or report text. Use case metadata, session events, artifact metadata, or explicit run manifests.

Artifacts are required when outputs need durable ADK-owned storage or versioning. Filesystem reports, recordings, transcripts, and case bundles are reviewer exports; build them from `EvalSuiteResult`, sessions, events, artifacts, state, and usage.

## Local Patterns




Legacy references may contain pre-current APIs such as `app.session()` or broad provider imports. Do not copy deprecated session APIs; `app.sessions.*` and provider subpath imports remain canonical.
