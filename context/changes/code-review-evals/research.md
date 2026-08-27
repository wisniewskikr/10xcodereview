---
date: 2026-08-27T15:09:22Z
researcher: Chris
git_commit: 084d688c1005c984a56407fab384d0f866e235bb
branch: feature/1
repository: wisniewskikr/10xcodereview
topic: "Eval-readiness of @packages/code-reviewer and promptfoo fit for evaluating the AI code-review agent"
tags: [research, codebase, code-reviewer, evals, promptfoo, ai-sdk]
status: complete
last_updated: 2026-08-27
last_updated_by: Chris
---

# Research: code-review-evals — eval-readiness of `@packages/code-reviewer` & promptfoo fit

**Date**: 2026-08-27T15:09:22Z
**Researcher**: Chris
**Git Commit**: 084d688c1005c984a56407fab384d0f866e235bb
**Branch**: feature/1
**Repository**: wisniewskikr/10xcodereview

## Research Question

Analyze the current state of `@packages/code-reviewer` in the context of introducing evals — reusability of prompts, importability of the agent, etc. First pick for the eval toolkit is **promptfoo**. If the tech stack is not aligned, analyze other OSS tools (via web search) for evaluating prompts and agents. Requested output: assessment **plus** a concrete promptfoo integration blueprint, and a full alternatives matrix. Priority eval targets: **prompt variants**, **full agent / tool loop**, **verdict & scoring**.

## Summary

**The package is already eval-ready by design, and promptfoo is the right first pick — with two caveats.**

1. **Eval-readiness: high.** `packages/code-reviewer` was deliberately restructured in the `tool-loop-agent` change *for* a future eval harness. The public barrel (`src/agent/index.ts`) is side-effect-free (importing it reads no `.env`, builds no model, touches no filesystem), `createCodeReviewer(options)` exposes every knob an eval would sweep (model, `promptVariant`, `workspaceRoot`, `temperature`, `maxSteps`, …), prompts live in a keyed record (`codeReviewInstructionVariants`), the output is a Zod schema exported from the same barrel, `computeVerdict()` is a pure exported function, and the model option accepts an injected `LanguageModel` so mocks work. Comments in the source literally say "Everything a prompt eval would want to sweep" and "the prompt-eval harness."

2. **promptfoo fits the bulk of the job** (prompt-variant sweep + structured-output validation + verdict-agreement regression gate): MIT, local-first, no account required, mature CI story, first-class custom-provider support for TypeScript, `is-json` + JSON-Schema assertions, `.mjs` `javascript` assertions that can import your compiled `computeVerdict`, and model-graded judges for the softer "are the findings any good" checks.

3. **Caveat A — abstraction mismatch.** promptfoo thinks "prompt string → provider". Our agent takes a structured `target` and owns its own prompting, so the eval funnels the target through `context.vars` with a dummy `prompts: ['{{target}}']`, and the `promptVariant` sweep lives in `providers[].config`, not promptfoo's `prompts:`. Workable, slightly against the grain.

4. **Caveat B — the "full agent / tool loop" target is promptfoo's weakest area.** Asserting *what the agent actually did* (which tools, in what order, how many steps, argument correctness) requires standing up promptfoo's OTLP tracing pipeline + AI SDK `experimental_telemetry` + `trajectory:*` assertions. That is the most complex part of the config and comparatively new. For deep tool-loop analysis, a thin **evalite** (Vitest-based) or `node:test` + **autoevals** harness that calls `createCodeReviewer().review()` directly and asserts over the returned `result.steps` is far less ceremony. Recommended shape: **promptfoo as the primary sweep + verdict gate; a small evalite/`node:test` harness for tool-loop assertions** — both MIT, both fully local.

> Note on promptfoo governance: as of 2026 promptfoo's own blog and widely-reported news state it was acquired by OpenAI (announced 2026-03) and "will remain open source under the current license"; OpenAI's deprecated Evals platform points migrations at it. This is second-hand (post knowledge-cutoff) and should be re-verified before the plan is written, but it does not change what matters here: the tool is MIT-licensed and runs fully locally with no account.

---

## Detailed Findings

## Part 1 — Current state of `packages/code-reviewer` for evals

### 1.1 The importable surface — one side-effect-free barrel

- **Package entry point** is the agent barrel: `packages/code-reviewer/package.json:8-15` sets `main`/`types`/`exports` to `dist/agent/index.js` (source: `src/agent/index.ts`). `"name": "@10xcodereview/code-reviewer"`, `"private": true`, `"type": "module"`.
- `src/agent/index.ts:1-8` — module doc: *"One import path for every consumer - the CLI in this package and, later, the prompt-eval harness … This module is side-effect free: importing it reads no .env, constructs no model, and touches no filesystem. Nothing happens until you call a factory."*
- The barrel re-exports everything an eval needs (`src/agent/index.ts:10-41`):
  - `createCodeReviewAgent`, `createCodeReviewer`
  - `diffTarget`, `fileTarget`, `inlineTarget` + `CodeReviewTarget` type
  - `CodeReviewAgentOptions`, `CodeReviewer`, `CodeReviewerOptions` types (the tuning surface)
  - `CodeReviewError`, `CodeReviewErrorReason`
  - `computeVerdict`
  - `renderReviewMarkdown`
  - `codeReviewSchema`, `findingSchema`, `CodeReview`, `Criteria`, `Criterion`, `Finding`
  - `codeReviewInstructionVariants`, `defaultPromptVariant`, `CodeReviewPromptVariant`
- **Not on the barrel** (deep-path import only): `runCi` (`src/ci.ts`), the terminal renderer `renderReview` (`src/cli/render.ts`).
- Config loading is lazy + memoized specifically so importing the barrel is free: `src/utils/config.ts:35-45` — doc comment: *"an eval harness may import [the barrel] long before it decides to build a reviewer."* Verified by an existing test: "Importing the barrel has no side effects with OPENROUTER_API_KEY unset" (`context/changes/tool-loop-agent/plan.md:449`).

### 1.2 Parameterization — the tuning surface

`CodeReviewAgentOptions` (`src/agent/code-review-agent.ts:25-44`) — doc comment line 22-24: *"Everything a prompt eval would want to sweep. All optional: with no options this is the CLI's reviewer, and each field falls back to `config.json`."*

| Option | Type | Falls back to |
| --- | --- | --- |
| `model` | `string \| LanguageModel` | `config.model` |
| `promptVariant` | `CodeReviewPromptVariant` | `defaultPromptVariant` (`"default"`) |
| `workspaceRoot` | `string` | `process.cwd()` |
| `temperature` | `number` | `config.temperature` (0) |
| `maxOutputTokens` | `number` | `config.maxOutputTokens` (16000) |
| `maxSteps` | `number` | `config.maxSteps` (40) |
| `maxRetries` | `number` | `config.maxRetries` (2) |
| `timeout` | `number` (per-call ms) | `config.requestTimeoutMs` (120000) |
| `maxFileBytes` | `number` | `config.maxFileBytes` (262144) |
| `maxSearchResults` | `number` | `config.maxSearchResults` (40) |

- Each is applied as `options.X ?? config.X` in `createCodeReviewAgent` (`src/agent/code-review-agent.ts:71-102`).
- **Not overridable per run**: `logDirectory`, `appName` (read directly from `getConfig()` in `src/utils/logger.ts:17,26`). No env-var overrides for any config key. Only env vars read anywhere: `OPENROUTER_API_KEY` (`src/services/model.ts:15`) and `GITHUB_OUTPUT` (`src/ci.ts:127`).
- `createCodeReviewer` returns `{ agent, review }` (`src/agent/code-review-agent.ts:48-51, 109-148`) — doc: *"A reviewer is immutable and safe to reuse across a fixture set: build one per variant, then push the same targets through each."* This is exactly the promptfoo "one provider instance per config" model.
- Historical intent: `context/changes/tool-loop-agent/plan.md:52` — *"Construction-time parameterisation also matches how a prompt eval actually works — build N reviewers, push identical fixtures through each."*

### 1.3 Prompt variants — reusability

- `src/prompts/code-review.ts:29-37` — `codeReviewInstructionVariants` is a `const` keyed record: `{ default, "evidence-first" }`. Doc: *"Instructions are a keyed record of named variants rather than one constant, so a prompt eval is a loop over the keys and every variant is a reviewable diff"* and *"Add a key here to make it available to an eval."*
- `CodeReviewPromptVariant = keyof typeof codeReviewInstructionVariants` (line 35); `defaultPromptVariant = "default"` (line 37). All three exported via the barrel.
- The `evidence-first` variant (`src/prompts/code-review.ts:17-27`) was seeded *specifically to exercise the mechanism*: `context/changes/tool-loop-agent/plan.md:92` — *"seed exactly one alternative so the variant mechanism is exercised rather than theoretical"* — and it is a genuinely different reviewing stance ("a confident guess is worse than silence", "Prefer three findings you verified over ten you assumed"), not a paraphrase (`plan.md:409`).
- **The six-criterion rubric is NOT in these instruction strings.** It lives in the Zod schema's `.describe()` annotations (`src/schemas/code-review.ts:19-56`) — 1/10 vs 10/10 anchors per criterion — which the model reads at generation time. `research.md` (ci-cd-code-review) `:151-155, 384-386` calls `.describe()` fields "prompt surface." So a prompt eval that only sweeps `promptVariant` is *not* sweeping the rubric; changing grading criteria is a schema edit.
- `buildCodeReviewPrompt(target)` (`src/prompts/code-review.ts:57-95`) is an exhaustive `switch (target.kind)` with no `default` (compiler-enforced). It builds the *user message*; the instruction variant is the *system/instructions* string passed separately (`src/agent/code-review-agent.ts:85`).

Prompt-variant evolution (from `git log -p -- src/prompts/code-review.ts`):
- `51b3089` original: single `codeReviewInstructions` constant.
- `2b00df1`: converted to the keyed `codeReviewInstructionVariants` record; added `evidence-first`.
- `f65a763`: added `CodeReviewTarget` discriminated union (`file` | `inline`); rewrote builder as exhaustive switch.
- `9d88484`: added `{ kind: "diff" }` union member + `case "diff"` branch ("Grade the change against all six criteria").

### 1.4 Output schema & verdict

- `src/schemas/code-review.ts:58-62` — `codeReviewSchema = z.object({ summary, criteria, findings })`.
  - `criteria` = 6 named criteria (`implementationCorrectness`, `idiomaticity`, `complexity`, `testCoverage`, `documentation`, `securityAndSafety`), each `{ grade: int 1-10, justification: string }` (`criteriaSchema`, lines 31-56).
  - `findings` = array of `{ file, line: int|null, severity: "info"|"warning"|"error", title, explanation, suggestion }` (`findingSchema`, lines 10-17).
- Schema module has zero AI-SDK imports — doc line 1-3: *"so the agent, the CLI renderer, and a future eval scorer can all import it without pulling in the AI SDK."*
- `computeVerdict(criteria) => "passed" | "failed"` (`src/agent/verdict.ts:8-20`) — pure, no I/O, no GitHub/label knowledge. Rule: **fail if any grade ≤ 4, or if `securityAndSafety.grade ≤ 6`; else pass.**
  - Thresholds are a documented *reasoned default, never empirically tuned*: `context/changes/ci-cd-code-review/plan-brief.md:32, 79-80` — *"reasoned defaults, not empirically tuned — expect to revisit both after the first few real PRs run through."* Origin: `ci-cd-code-review/research.md:414-416`. The numbers themselves have no explaining comment in `verdict.ts`.
  - Not configurable — `ci-cd-code-review/plan.md:80-81`: *"the floor rule is hardcoded in the package, not exposed via `config.json`."*
  - **This is the single strongest argument for a verdict-agreement eval**: the gate that decides pass/fail on real PRs is an untuned heuristic, and (see 1.9) the reviewer structurally cannot review its own verdict code.

### 1.5 Targets & fixture helpers

- `CodeReviewTarget` union (`src/prompts/code-review.ts:45-48`):
  - `{ kind: "file"; path: string }` — code deliberately *not* in the prompt; agent must use `readFile`.
  - `{ kind: "inline"; fileName: string; code: string }` — code carried in the prompt, "not on disk."
  - `{ kind: "diff"; title: string; description?: string; diff: string }` — PR review.
- Constructors exported from the barrel (`src/agent/code-review-agent.ts:170-190`):
  - `fileTarget(path)`, `inlineTarget(fileName, code)` (comment: *"Convenience for fixtures that carry their code as a string"*), `diffTarget(title, diff, description?)`.
- `diffTarget` runs `excludeDirectoryFromDiff(diff, "packages")` (`src/agent/code-review-agent.ts:184-190`, `src/utils/diff-filter.ts`) — drops per-file hunks under `packages/` so a PR touching the reviewer's own source isn't graded by the reviewer. Landed ad-hoc in commit `b0ee0ce`, no plan doc. **Relevant to evals**: an eval harness is the only quality check on the reviewer's own prompt/schema/verdict code.
- `inline` kind was kept expressly for eval fixtures: `context/changes/tool-loop-agent/plan-brief.md:22` — *"string-based eval fixtures."*

### 1.6 Model injection / mockability

- `resolveModel` (`src/agent/code-review-agent.ts:53-59`): `undefined` → `createReviewModel(config.model)`; `string` → `createReviewModel(string)` (OpenRouter lookup); **anything else is returned as-is** → inject a `LanguageModel` (mock or a pre-built provider).
- `createReviewModel(modelId)` (`src/services/model.ts:11-19`) is the single place OpenRouter creds are read; model id is a parameter so one process can hold several reviewers on different models.
- Existing tests inject `MockLanguageModelV4` from `ai/test`:
  - `src/agent/code-review-agent.test.ts:6` `import { MockLanguageModelV4 } from "ai/test";`
  - `respondingWith(text)` (lines 36-45) builds a `doGenerate` returning `content: [{ type: "text", text }]`, `finishReason: { unified: "stop" }`, a fake `usage`.
  - Variants for `finishReason: "length"` (maxOutputTokens cutoff), tool-call-forever (budget exhaustion), and a throwing `doGenerate` (provider error).
  - Injection: `createCodeReviewer({ model, workspaceRoot: makeWorkspaceRoot(), maxSteps })` (lines 78-80).
  - `src/ci.test.ts` does the same through `runCi({ ..., model })`; `RunCiOptions.model` is documented as a *"Test-only escape hatch"* (`src/ci.ts:23-25`).
- **Implication**: prompt/verdict evals that must be deterministic and free can run entirely on `MockLanguageModelV4`; only end-to-end quality evals need a real model + `OPENROUTER_API_KEY`.

### 1.7 Tracing & tool-loop observability

- `createTracingCallbacks(context)` (`src/agent/tracing.ts:45-102`) returns a plain object of AI SDK v7 `ToolLoopAgent` lifecycle handlers, spread into the constructor at `src/agent/code-review-agent.ts:97-101`. Hook names (v7): `onStart`, `onStepStart`, `onToolExecutionEnd`, `onStepEnd`, `onEnd` (**not** `onStepFinish`).
- These handlers **only `log.info(...)` to a file** — they don't accumulate or return anything. Tool-input keys allowed into logs are an allowlist (`tracing.ts:17`): `path, query, filePattern, startLine, endLine, caseSensitive`. Tool *results* are never logged.
- **There is no way to pass extra callbacks through `CodeReviewAgentOptions` today.** A harness that wants tool-loop metrics has three options:
  1. Use the returned `agent` (`CodeReviewer.agent`, `src/agent/code-review-agent.ts:49,147`) and read `result.steps` / `result.usage` / `result.finishReason` from `agent.generate({ prompt })` — the reviewer already does this at `code-review-agent.ts:118, 132-142`. `CodeReviewError` also carries `steps` + `usage` on failure (`src/agent/errors.ts:24-26`).
  2. Wrap the injected model (e.g. count `doGenerate` calls, or use evalite's `traceAISDKModel`).
  3. Fork `createCodeReviewAgent` to merge its own callbacks.
- Tracing was built *partly to give evals something to score*: `context/changes/tool-loop-agent/plan-brief.md:28` — *"gives a future eval behaviour to score, not just final JSON"*; `plan.md:234` same.
- **Cost baseline** (for eval budgeting): one real single-file run measured ~158,818 input + 5,132 output tokens over 11 steps (`ci-cd-code-review/research.md:131, 396-397`).
- **Non-determinism is a logged, known eval risk**: `tool-loop-agent/plan-brief.md:68` — *"Tool use makes runs less deterministic, which will make eval scoring noisier than the current single-shot call."* Also `ci-cd-code-review/plan-brief.md:81-83`.

### 1.8 Config override model

- `config.json` (12 keys) is loaded once, Zod-validated, memoized (`src/utils/config.ts:5-45`); path via `fromProjectRoot("config.json")`. Invalid config throws with `z.prettifyError`.
- **Per-run override = the options object, not env vars.** To change defaults for a whole eval run you either edit `config.json` (git-tracked) or pass options to each `createCodeReviewer(...)` call. The latter is cleaner and is what the design intends.

### 1.9 Gaps for eval work (what is NOT there yet)

1. **No eval harness, runner, dataset format, scorers, or CI wiring.** Explicitly out of scope of the prior change: `tool-loop-agent/plan.md:37` — *"No eval environment … This change only makes the reviewer importable and parameterisable so that work can start cleanly later."*
2. **No fixture corpus.** The only committed "known-bad" code is `sampleCode` in `src/index.ts:13-19` (an `averageOf` with an off-by-one). No `fixtures/` / `evals/` / golden files anywhere. Test inline targets are throwaways (`"export const answer = 42;"`).
3. **No foundation doc for quality/evals.** `context/foundation/` holds only `README.md` — no `test-plan.md`, `tech-stack.md`, `prd.md`, `lessons.md`. `context/changes/code-review-evals/` currently holds only `change.md` (status was `new`, now `preparing`; title *"Introduce promptfoo for evaluating the AI code-review agent"*). This research doc is the first artifact in it.
4. **No token/cost surfaced from `review()`.** `createCodeReviewer().review()` returns `CodeReview` only — not `result.usage`. A harness that wants per-case cost must use the lower-level `agent` and call `agent.generate()` itself, or wrap the model.
5. **No extra-callbacks seam** on `CodeReviewAgentOptions` (see 1.7).
6. **Verdict thresholds hardcoded + unverifiable by the CI reviewer itself** (see 1.4 / 1.5).
7. **`renderReviewMarkdown`** (`src/cli/render-markdown.ts:59-69`) renders exactly one review — no aggregation, no expected-vs-actual diff, no model/variant/timing columns. Reusable per-case, not as an eval report.

### 1.10 Eval-readiness scorecard

| Dimension | State | Evidence |
| --- | --- | --- |
| Agent importable without side effects | ✅ Excellent | `src/agent/index.ts:1-8`; barrel = package `main` |
| Parameterized for sweeps | ✅ Excellent | `CodeReviewAgentOptions` 10 optional fields, all `?? config` |
| Prompt variants reusable | ✅ Good | keyed record, barrel-exported; rubric is separate (schema `.describe()`) |
| Structured output for scoring | ✅ Excellent | `codeReviewSchema` exported, AI-SDK-free |
| Verdict logic testable | ✅ Excellent | `computeVerdict` pure & exported; thresholds untuned → *needs* an eval |
| Model mockable / deterministic runs | ✅ Excellent | `model?: string \| LanguageModel`; `MockLanguageModelV4` already used |
| Fixture ergonomics | ✅ Good | `fileTarget` / `inlineTarget` / `diffTarget` exported |
| Tool-loop observability | 🟡 Partial | tracing logs only; `result.steps` reachable via `.agent`; no callback seam |
| Per-run token/cost from `review()` | 🟡 Partial | returns `CodeReview` only; use `.agent.generate()` for `usage` |
| Fixture corpus | ❌ Missing | only `sampleCode` in `src/index.ts` |
| Eval runner / dataset / CI | ❌ Missing (by design) | `tool-loop-agent/plan.md:37` |
| Quality/eval foundation doc | ❌ Missing | `context/foundation/` = README only |

---

## Part 2 — promptfoo fit

### 2.1 Verdict: yes for the sweep + verdict gate; supplement for tool-loop

promptfoo is MIT, local-first (no account; optional self-hostable sharing), ~22k★, mature CI story. It maps cleanly onto two of the three priority targets (**prompt variants**, **verdict & scoring**) and needs its tracing add-on for the third (**full agent / tool loop**).

### 2.2 How the agent plugs in — a custom TypeScript provider

- promptfoo's `vercel:` provider is only for reaching models through Vercel AI Gateway — it does **not** run our `ToolLoopAgent`. (https://www.promptfoo.dev/docs/providers/vercel/)
- The path is a **custom `file://` provider** in TypeScript that imports `createCodeReviewer` and calls `.review(target)` inside `callApi`. promptfoo loads `.ts` provider files itself (no `tsx`/`ts-node` needed); it lists TypeScript as "Direct support with type safety via interfaces." (https://www.promptfoo.dev/docs/providers/custom-api/)
- `callApi(prompt, context)` receives `context.vars` (the dataset row), `context.test`, `context.traceparent` (when tracing on), a logger. It returns `ProviderResponse`: `{ output, error, tokenUsage, cost, cached, metadata, ... }`. `output` may be structured, but some model-graded asserts stringify objects to `"[object Object]"` (promptfoo#4014) — so **return `JSON.stringify(review)`** and let `is-json` / `transform` re-parse.
- Because the agent takes a structured `target` (not a prompt string), the provider ignores `prompt` and reads `context.vars.target`; the config uses a passthrough `prompts: ['{{target}}']`.
- Sweeping `promptVariant` / `model` is done as **multiple `providers` entries pointing at the same file with different `config`** — the natural promptfoo idiom, and it lines up with "one immutable reviewer per variant" from `src/agent/code-review-agent.ts:105-108`.

### 2.3 Alignment table

| Eval goal | promptfoo mechanism | Notes |
| --- | --- | --- |
| Sweep prompt variants (`default` vs `evidence-first` vs future) | N `providers` entries, `config.promptVariant`, one dataset → matrix report | per-variant metric columns; GH Action comments before/after diff |
| Sweep models | same, `config.model` (string id or, for determinism, an injected mock) | |
| Structured output valid | `is-json` + JSON Schema (`file://…schema.json`, generated from Zod via `z.toJSONSchema`) | needs string output from provider |
| Verdict agreement | `.mjs` `javascript` assertion importing compiled `computeVerdict`; compare to `vars.expectedVerdict`; emit `verdict_agreement` named metric + `threshold` | the CI-gatable deterministic check |
| Findings precision/recall vs golden | `.mjs` `javascript` assertion diffing `review.findings` against `vars.expectedFindings` (match on file+line±window / category) | custom scorer; emit `finding_recall`, `finding_precision` |
| "Are findings specific & actionable" | `g-eval` / `llm-rubric`, judge pinned + `temperature: 0`, `threshold` with margin, **off the blocking gate** | model-graded flake |
| Criteria grades sane | `g-eval` rubric or `.mjs` numeric checks (e.g. grade within ±2 of expected band) | |
| Tool-loop behaviour (tools used, order, step count) | `tracing.enabled` + AI SDK `experimental_telemetry` + `trajectory:tool-used` / `trajectory:tool-sequence` / `trace-span-count` | Caveat B — heaviest setup; see Part 3.6 |
| CI gate | `promptfoo eval` exit 1 on failure; `-o results.json`/`.html`; disk cache; `--max-concurrency`; `promptfoo/promptfoo-action` | keep a `tag`-filtered deterministic subset for PRs, full sweep nightly |

### 2.4 Weak spots / friction (promptfoo, this use case)

1. **Abstraction mismatch** — structured `target` funneled through `vars` + dummy `prompts`; variant sweep in `providers[].config` not `prompts:`. Against the grain but fine.
2. **Tool-loop assertions cost setup** — OTLP receiver + `experimental_telemetry` + `traceparent` propagation; trajectory grading is streaming-dependent (extra tokens/time); assertions are newer/less battle-tested.
3. **TS/ESM edges** — custom *provider* `.ts` is fine; **`javascript` assertion files should be `.mjs`** and `.ts` is not documented as supported → must compile `computeVerdict` + schema to `dist/` and import that (the package already emits `dist/` via `npm run build`; ESM `nodenext`, `.js` import specifiers). promptfoo Node floor is `^20.20.0 || >=22.22.0` — the package's `"node": ">=20.12"` (`package.json:6`) should rise to `>=20.20`, and plan the jump to 22.
4. **Not a `node:test` citizen** — separate runner/CLI; run as its own `npm run eval` + CI job (or call `promptfoo.evaluate()` programmatically).
5. **Model-graded flake** — pin judge model + `temperature: 0`, use `--repeat`, give thresholds margin, keep model-graded asserts out of the blocking gate.
6. **Non-determinism of the agent itself** (tool use) — already flagged in prior changes; mitigate with `temperature: 0` (already the default), `--repeat`, and mock-model runs for the deterministic subset.

---

## Part 3 — Integration blueprint

> No code is committed by this research. This is a copy-paste-ready design for the `/10x-plan` step.

### 3.1 Directory layout (proposed)

```
packages/code-reviewer/
├── src/…                      # unchanged
├── eval/
│   ├── promptfooconfig.yaml
│   ├── provider.ts            # custom provider wrapping createCodeReviewer
│   ├── asserts/
│   │   ├── verdict-agreement.mjs
│   │   └── findings-recall.mjs
│   ├── schemas/
│   │   └── code-review.schema.json   # generated from Zod at build time
│   ├── datasets/
│   │   ├── verdict.jsonl      # {target, expectedVerdict, notes}
│   │   ├── findings.jsonl     # {target, expectedFindings[]}
│   │   └── smoke.jsonl        # tiny always-green subset (mock model)
│   └── fixtures/              # known-good / known-bad source files & diffs
│       ├── good/
│       └── bad/
└── package.json              # + "eval", "eval:ci", "eval:schema" scripts
```

Rationale for `eval/` inside the package (not repo root): the provider imports the barrel by relative path; `config.json` resolution follows the module; the `packages/` self-review exclusion doesn't apply to `inline`/`file` targets used here.

### 3.2 Custom TS provider (`eval/provider.ts`)

```ts
import type {
  ApiProvider, ProviderOptions, ProviderResponse, CallApiContextParams,
} from "promptfoo";
import { createCodeReviewer, computeVerdict } from "../src/agent/index.js";
import type { CodeReviewTarget } from "../src/agent/index.js";

export default class CodeReviewerProvider implements ApiProvider {
  private readonly label: string;
  private readonly cfg: Record<string, unknown>;

  constructor(options: ProviderOptions) {
    this.label = options.id ?? "code-reviewer";
    this.cfg = options.config ?? {};
  }

  id(): string { return this.label; }

  async callApi(_p: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const vars = context?.vars ?? {};
    try {
      const reviewer = createCodeReviewer({
        model: this.cfg.model as string | undefined,        // undefined => config.json model
        promptVariant: this.cfg.promptVariant as never,     // "default" | "evidence-first"
        workspaceRoot: this.cfg.workspaceRoot as string | undefined,
        temperature: (this.cfg.temperature as number) ?? 0,
        maxSteps: (this.cfg.maxSteps as number) ?? undefined,
      });

      const target = JSON.parse(String(vars.target)) as CodeReviewTarget;

      // For tool-loop metrics, use reviewer.agent.generate() instead and read result.steps/usage.
      const review = await reviewer.review(target);

      return {
        output: JSON.stringify(review),
        metadata: {
          verdict: computeVerdict(review.criteria),
          findingCount: review.findings.length,
        },
      };
    } catch (err) {
      // Return, don't throw: a graceful test failure with a readable reason.
      return { error: `code-reviewer failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
```

- Path aliases must resolve via `tsconfig.json` (no bundler in promptfoo's loader) — relative `../src/agent/index.js` avoids that entirely.
- To also capture `tokenUsage`/`cost`, switch to `reviewer.agent.generate({ prompt: buildCodeReviewPrompt(target) })` and map `result.usage` → `ProviderResponse.tokenUsage`. `buildCodeReviewPrompt` is not barrel-exported today — either add it to the barrel or keep `review()` and forgo per-case cost in v1.

### 3.3 `eval/promptfooconfig.yaml`

```yaml
description: code-reviewer prompt-variant sweep + verdict agreement

prompts:
  - "{{target}}"                       # passthrough; provider reads context.vars.target

providers:
  - id: file://./provider.ts
    label: default@sonnet
    config: { promptVariant: default,        model: anthropic/claude-sonnet-5, temperature: 0 }
  - id: file://./provider.ts
    label: evidence-first@sonnet
    config: { promptVariant: evidence-first,  model: anthropic/claude-sonnet-5, temperature: 0 }

defaultTest:
  options:
    provider: anthropic:claude-sonnet-5      # judge model for g-eval/llm-rubric
  assert:
    - type: is-json
      value: file://./schemas/code-review.schema.json
      metric: schema_valid
      weight: 2

tests:
  - file://./datasets/verdict.jsonl
  - file://./datasets/findings.jsonl

evaluateOptions:
  maxConcurrency: 4
  repeat: 1            # bump to 3 for stability runs
```

Per-row assertions live in the dataset files (see 3.5) so each row can carry its own `expectedVerdict` / `expectedFindings`.

### 3.4 Assertion strategy per priority target

**(a) Verdict & scoring** — deterministic, CI-gatable.

`eval/asserts/verdict-agreement.mjs`:
```js
import { computeVerdict } from "../../dist/agent/verdict.js";   // compiled, not src/*.ts

export default (output, ctx) => {
  const review = JSON.parse(output);
  const expected = ctx.vars.expectedVerdict;                    // "passed" | "failed"
  const actual = computeVerdict(review.criteria);
  const pass = actual === expected;
  return {
    pass, score: pass ? 1 : 0,
    reason: `verdict expected=${expected} actual=${actual}`,
    namedScores: { verdict_agreement: pass ? 1 : 0 },
  };
};
```
Gate CI on the `verdict_agreement` metric threshold (e.g. ≥ 0.9 across the labelled set).

**(b) Prompt variants** — comparative, not pass/fail.
- `is-json` + schema on every row (already in `defaultTest`).
- `findings-recall.mjs`: diff `review.findings` against `ctx.vars.expectedFindings` (match on `file` + `line` within ±3, or on a `category` tag). Emit `finding_recall`, `finding_precision` named metrics. Report per variant; do **not** gate initially.
- Optional `g-eval` "findings cite real lines and give minimal actionable fixes" with `metric: finding_quality`, `threshold: 0.7`, off the gate.

**(c) Full agent / tool loop** — see 3.6.

### 3.5 Dataset / fixture shape

`eval/datasets/verdict.jsonl` (one JSON object per line):
```json
{"vars":{"target":"{\"kind\":\"file\",\"path\":\"eval/fixtures/bad/off-by-one.ts\"},\"expectedVerdict\":\"failed\"},"assert":[{"type":"javascript","value":"file://./asserts/verdict-agreement.mjs","metric":"verdict_agreement","weight":3}]}
```

Fixture families to seed (small, high-signal — mirrors the six criteria):
| Family | Example fixture | Expected |
| --- | --- | --- |
| Correctness bug | off-by-one loop bound (reuse `src/index.ts` `sampleCode`) | `failed`, finding on the loop line |
| Security | unsanitised path join / secret in source | `failed` (security ≤ 6) |
| Clean code | a real, well-tested file from `src/` copied in | `passed`, `findings: []` |
| Boundary | criteria crafted to grade exactly 5 / security 7 | `passed` (tests the threshold edge, cf. `ci-cd-code-review/plan.md:493-495`) |
| Diff review | a synthetic PR diff touching a non-`packages/` path | verdict + affected-file naming |
| Idiomaticity / complexity / docs / tests | one targeted fixture each | grade band per criterion |

Targets can be `inline` (code in the row, zero disk setup — the kind kept for fixtures) or `file` (forces the tool loop — better for target (c)).

### 3.6 Tool-loop / trajectory assertions (target c)

Two routes; pick per how much this matters:

**Route 1 — promptfoo OTLP tracing (stay in one tool).**
```yaml
tracing:
  enabled: true
  otlp: { http: { enabled: true } }      # receiver on :4318
  storage: { type: sqlite, retentionDays: 30 }
```
In the provider, propagate `context.traceparent` and enable AI SDK telemetry on the underlying `generate` call (`experimental_telemetry: { isEnabled: true }`). promptfoo normalises `ai.toolCall.*` spans, so:
```yaml
assert:
  - type: trajectory:tool-used        # value: readFile
  - type: trajectory:tool-sequence    # value: { steps: [readFile, search] }
  - type: trace-span-count            # bound the loop size
  - type: trace-error-spans           # no rejected tool calls
```
Cost: OTLP wiring is the most complex part of the config; trajectory grading needs streaming (extra tokens/time). The reviewer today does **not** pass `experimental_telemetry` through — needs a small change to `createCodeReviewAgent` (a `telemetry?: boolean` option, or always-on when an env flag is set).

**Route 2 — evalite / `node:test` + `result.steps` (less ceremony).**
Call `createCodeReviewer(opts).agent.generate({ prompt })` directly, or wrap the model with evalite's `traceAISDKModel(model)` (one line), then assert over `result.steps` — tool names, order, `steps.length`, `usage`. No OTLP, local trace UI included. This is the recommended home for target (c); keep promptfoo for (a) and (b).

### 3.7 CI wiring

- New `package.json` scripts:
  - `"eval:schema": "tsx eval/gen-schema.ts"` — `z.toJSONSchema(codeReviewSchema)` → `eval/schemas/code-review.schema.json`.
  - `"eval": "promptfoo eval -c eval/promptfooconfig.yaml"`.
  - `"eval:ci": "promptfoo eval -c eval/promptfooconfig.yaml --filter-pattern smoke -o eval-results.json --no-progress-bar"`.
- New workflow `.github/workflows/ai-code-review-eval.yml` (separate from the PR-triggered `ai-code-review.yml`):
  - PR trigger → run `npm run build` then `eval:ci` (deterministic subset, mock model where possible) → exit 1 fails the check.
  - Optional `promptfoo/promptfoo-action` to comment the before/after diff.
  - `schedule:` nightly → full sweep with real model + model-graded asserts + `--repeat 3`, upload `-o results.html` as an artifact; do not gate.
- Cache: promptfoo's disk cache (`~/.promptfoo/cache`) keyed by provider+prompt+config; persist it in CI (`actions/cache`) to keep the nightly cheap. Set `PROMPTFOO_CACHE_ENABLED` appropriately.
- Reuse the diff-fetch/60k-cap steps from `.github/actions/ai-code-review/action.yml:36-69` if evaluating on real PR diffs.

### 3.8 Package / tooling changes required (small)

| Change | Where | Why |
| --- | --- | --- |
| Add `promptfoo` devDep | `packages/code-reviewer/package.json` | the runner |
| Add `eval*` scripts | same | invoke |
| Bump `engines.node` to `>=20.20` (plan 22) | same | promptfoo floor |
| Generate JSON Schema from Zod | `eval/gen-schema.ts` (build step) | `is-json` assertion source |
| (optional) barrel-export `buildCodeReviewPrompt` | `src/agent/index.ts` | let provider use `agent.generate()` for `usage`/telemetry |
| (optional) `telemetry?: boolean` option | `src/agent/code-review-agent.ts` | Route 1 trajectory asserts |
| (optional) extra-callbacks seam on `CodeReviewAgentOptions` | same | Route 2 metrics without wrapping the model |
| `.gitignore` `eval-results.*`, `.promptfoo/` | `packages/code-reviewer/.gitignore` | artifacts |

None of these touch the reviewer's runtime behaviour; the optional ones are additive options.

---

## Part 4 — OSS alternatives, full matrix

| Tool | TS-native | Agent tool-loop assertions | JSON-schema assert | LLM-judge | Local-first (no account) | CI | License | 2026 maturity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **promptfoo** | Yes (providers); `.mjs` for asserts | Yes, via OTLP `trajectory:*` (add-on) | `is-json` + schema (built-in) | Rich built-in (`llm-rubric`, `g-eval`, `factuality`, `select-best`, `agent-rubric`…) | Yes | Excellent — GH Action, exit codes, disk cache, concurrency | MIT | Very high; ~22k★; (reported) OpenAI-owned, stays OSS |
| **evalite** | Yes (built on Vitest) | DIY in a scorer over `traceAISDKModel` trace / returned steps | DIY scorer (`JSON.parse` + Zod) | BYO / `autoevals` | Yes; local UI, no key | `evalite run`; `scoreThreshold` → exit 1; static HTML bundle | MIT | v1 beta, fast-moving, ~1.7k★; maintainer Matt Pocock |
| **autoevals** (lib) + Braintrust (platform) | Yes (lib, TS+Py) | No (scorer library only) | `ValidJSON`, `JSONDiff` | Rich prebuilt (`Factuality`, `ClosedQA`, `Battle`, `Security`, RAG…) | `autoevals` yes; **platform hosted/proprietary** | via a runner / `braintrustdata/eval-action` | MIT (lib); platform commercial | lib actively maintained; platform mature |
| **DeepEval** | Partial — `deepeval-ts` is beta & mostly a platform client; local judge metrics are **Python-only** | Best-in-class — tool-selection/correctness, task completion, arg correctness, span-level, tool-graph viz | Yes (Python) | Extensive (`GEval`, `DAGMetric`, faithfulness…) | Python pkg runs local; Confident AI is optional hosted | `deepeval test run` via pytest; GH Actions | Apache-2.0 | Very high (Python); DeepEval 4.0 in 2026 |
| **Langfuse** | Yes (TS SDK v4, OTel-based) | Auto OTel traces of nested steps + run/trace evaluators | DIY code evaluator | Built-in LLM-as-judge (configurable) + autoevals | Evaluators run local, **but need a Langfuse server** (Cloud or self-host: Postgres+ClickHouse+Redis) | Documented CI regression use; webhooks; heavier infra | MIT core (some enterprise-gated) | Very high; ClickHouse-owned (2026); v4 cutover 2026-11-16 |
| **OpenAI Evals** | No (Python) | No | Limited | Yes | Hosted platform **deprecated → shut down 2026-11-30**; OSS repo dormant | — | MIT (OSS repo) | Not a choice for new work; migration path is promptfoo |

### 4.1 Per-tool fit notes

- **promptfoo** — best for the declarative prompt/model matrix sweep, structured-output + rubric scoring, and a CI regression gate. That is the bulk of this project. Weak on ergonomic tool-loop introspection.
- **evalite** — best for the tool-loop / trajectory slice: `task` = `createCodeReviewer().review(target)`, wrap the model with `traceAISDKModel` (one line), assert over captured steps in a scorer, watch it in a local UI. Evals feel like Vitest tests, which matches the repo's `node:test` habit. Younger project.
- **autoevals** — use as a *scorer library* inside evalite or `node:test` (MIT, standalone, judge model configurable). Zero framework lock-in. Adopt the Braintrust *platform* only if a hosted experiment dashboard is wanted (it is not local-first).
- **DeepEval** — deepest agent/tool metrics, but a Python sidecar for a TS-ESM `node:test` shop; its TS SDK is not yet a local eval engine. Consider only if tool-loop metrics become the primary deliverable and a Python job in CI is acceptable.
- **Langfuse** — the right tool when *production observability + tracing + prompt management* is the goal, not a pre-merge gate. Needs a server. Revisit post-launch.
- **OpenAI Evals** — skip.

### 4.2 Recommended split

1. **promptfoo** — primary. Prompt-variant sweep, structured-output validation, verdict-agreement regression gate in CI. MIT, local, no account.
2. **evalite** (or `node:test` + **autoevals**) — secondary, only if/when tool-loop detail matters. `traceAISDKModel` + assertions over `result.steps`. MIT, local.
3. Defer Langfuse to production monitoring; do not adopt DeepEval unless a Python job is acceptable.

Both primary and secondary are MIT and fully local, so this is not a lock-in decision.

---

## Code References

- `packages/code-reviewer/package.json:8-15` — barrel is the package entry (`dist/agent/index.js`), `exports` map
- `packages/code-reviewer/src/agent/index.ts:1-8` — side-effect-free contract, "prompt-eval harness" named
- `packages/code-reviewer/src/agent/index.ts:10-41` — full re-export list (targets, schema, verdict, prompt variants, errors, renderer)
- `packages/code-reviewer/src/agent/code-review-agent.ts:22-46` — `CodeReviewAgentOptions` ("Everything a prompt eval would want to sweep")
- `packages/code-reviewer/src/agent/code-review-agent.ts:53-59` — `resolveModel`: injected `LanguageModel` passes through (mock path)
- `packages/code-reviewer/src/agent/code-review-agent.ts:71-102` — `createCodeReviewAgent`, `options.X ?? config.X`, tracing spread
- `packages/code-reviewer/src/agent/code-review-agent.ts:105-148` — `createCodeReviewer` returns `{ agent, review }`, "safe to reuse across a fixture set"
- `packages/code-reviewer/src/agent/code-review-agent.ts:170-190` — `fileTarget` / `inlineTarget` / `diffTarget` + `excludeDirectoryFromDiff(diff, "packages")`
- `packages/code-reviewer/src/prompts/code-review.ts:29-37` — `codeReviewInstructionVariants` keyed record; "Add a key here to make it available to an eval"
- `packages/code-reviewer/src/prompts/code-review.ts:45-95` — `CodeReviewTarget` union + exhaustive `buildCodeReviewPrompt`
- `packages/code-reviewer/src/schemas/code-review.ts:10-67` — `findingSchema`, `criteriaSchema` (`.describe()` = prompt surface), `codeReviewSchema`, exported types
- `packages/code-reviewer/src/agent/verdict.ts:8-20` — `computeVerdict`: any grade ≤ 4 → fail; security ≤ 6 → fail
- `packages/code-reviewer/src/agent/tracing.ts:17,45-102` — lifecycle callbacks (`onStart`/`onStepStart`/`onToolExecutionEnd`/`onStepEnd`/`onEnd`), tool-input allowlist, log-only
- `packages/code-reviewer/src/services/model.ts:11-19` — single OpenRouter cred read; model id is a parameter
- `packages/code-reviewer/src/utils/config.ts:35-45` — lazy memoized `getConfig()`; doc anticipates eval-harness import
- `packages/code-reviewer/src/ci.ts:17-31,56-78` — `RunCiOptions` (`model` = "Test-only escape hatch"), `runCi` never throws, returns `{ verdict, commentPath }`
- `packages/code-reviewer/src/cli/render-markdown.ts:59-69` — `renderReviewMarkdown(review)`: one review, no aggregation
- `packages/code-reviewer/src/index.ts:13-19` — `sampleCode`, the only committed known-bad snippet
- `packages/code-reviewer/src/agent/code-review-agent.test.ts:6,36-80` — `MockLanguageModelV4` from `ai/test`, `respondingWith`, injection via `createCodeReviewer({ model })`
- `packages/code-reviewer/src/ci.test.ts:6,35-60` — same mock pattern through `runCi({ model })`
- `packages/code-reviewer/tsconfig.json:7-19` — `module`/`moduleResolution` `nodenext`, `verbatimModuleSyntax`, `isolatedModules` (ESM, `.js` import specifiers, `import type`)
- `packages/code-reviewer/package.json:22` — `test` = `node --import tsx --test "src/**/*.test.ts"` (Node built-in runner)
- `.github/workflows/ai-code-review.yml` / `.github/actions/ai-code-review/action.yml:36-82` — PR label trigger, diff fetch + 60k cap, `npm run ci --prefix packages/code-reviewer -- --workspace … --diff-file … --comment-path …`

## Architecture Insights

- **The package was built for an eval harness before the harness existed.** `context/changes/tool-loop-agent/` restructured it precisely so "the prompt evals coming later can import the reviewer and sweep variants instead of editing source between runs" (`plan-brief.md:7`), with `eval harness` drawn as a first-class barrel consumer (`plan-brief.md:42`). Every design choice an eval cares about — side-effect-free barrel, factory with overrides, keyed prompt variants, typed error reasons, lifecycle tracing — was made with that in mind and documented as such.
- **Config follows the module; workspace follows the process.** `getConfig()` resolves from the package root; `workspaceRoot` defaults to `process.cwd()`. `ci-cd-code-review/research.md:373-376`: *"Built for evals, it happens to be exactly the shape a runner needs."*
- **Determinism is the recurring eval risk.** Tool use makes runs noisier than the old single-shot call; this is called out in three prior docs. Mitigations available today: `temperature: 0` (already default), mock models for the deterministic subset, `--repeat` for stability runs.
- **The rubric is in the schema, not the prompt.** Sweeping `promptVariant` sweeps *reviewing stance*, not *grading criteria*. Changing what "8/10 complexity" means is a `src/schemas/code-review.ts` `.describe()` edit — which an eval should also be able to A/B, but the current variant mechanism doesn't cover it.
- **The CI verdict gate is an untuned heuristic the reviewer can't review.** `computeVerdict` thresholds (4 / 6) are a reasoned guess awaiting real data, and `excludeDirectoryFromDiff(diff, "packages")` means a PR changing `verdict.ts` is never model-reviewed. A verdict-agreement eval on labelled fixtures is the intended way to close that loop.

## Historical Context (from prior changes)

- `context/changes/tool-loop-agent/plan-brief.md:7,22-28,42,68` — the eval-driven rationale for the factory, barrel, keyed prompt variants, inline target kind, tracing; and the non-determinism warning.
- `context/changes/tool-loop-agent/plan.md:5,37,52,92,234,255-256,306,409,449` — "future eval harness can import and sweep it"; "No eval environment" (explicitly deferred); option objects are "the eval harness's tuning surface"; barrel must stay side-effect-free (tested).
- `context/changes/ci-cd-code-review/plan-brief.md:32,79-83` — verdict floor rule (≤4 / security ≤6) as a "reasoned default, not empirically tuned"; blocking/merge-gating rejected because "an identical re-run could flip the verdict."
- `context/changes/ci-cd-code-review/plan.md:20-23,80-81,159-165,174-177,493-495` — the CI change rode on the barrel's existing eval affordances; threshold hardcoded, not in `config.json`; boundary test at grade 5 / security 7.
- `context/changes/ci-cd-code-review/research.md:131,151-155,373-376,384-386,396-397,400-406` — `.describe()` as "prompt surface"; "built for evals … exactly the shape a runner needs"; ~164k-token cost baseline; `context/foundation/` has no tech-stack/PRD/lessons doc.
- `context/changes/code-review-evals/change.md` — the change this research belongs to; title "Introduce promptfoo for evaluating the AI code-review agent"; status advanced `new` → `preparing` by this research; previously held only `change.md`.
- Commit `b0ee0ce` "Remove code-reviewer from code review requests" — added `excludeDirectoryFromDiff`, no plan/research doc.
- `git log -p -- packages/code-reviewer/src/prompts/code-review.ts` — variant record introduced in `2b00df1`; `evidence-first` seeded to exercise the mechanism; `diff` target added in `9d88484`.

## Related Research

- `context/changes/ci-cd-code-review/research.md` — the first research artifact in the repo; the CI consumer of the same barrel. Frontmatter commit/branch there (`8b742f79…`, `main`) is stale relative to current `HEAD`.
- `context/changes/tool-loop-agent/plan.md` and `plan-brief.md` — the change that made the reviewer importable/parameterised.

## Open Questions

1. **promptfoo governance** — re-verify the OpenAI-acquisition / "stays OSS under current license" claim before committing (post knowledge-cutoff, second-hand). Decision is low-risk either way given MIT + local-first, but the plan should cite a checked source.
2. **Judge model** — which model grades `g-eval`/`llm-rubric`? Same family as the reviewer (`anthropic/claude-sonnet-5`) risks shared blind spots; a different family costs a second key. Pin whichever + `temperature: 0`.
3. **Fixture provenance** — hand-write known-bad fixtures, or mine real merged PRs / past incidents from this repo's history? Real diffs are higher-signal but need labelling effort.
4. **Verdict re-tuning** — should this change also re-tune the 4 / 6 thresholds from the eval results, or only measure agreement and leave tuning to a follow-up? (`computeVerdict` would need to accept thresholds, currently hardcoded.)
5. **Rubric A/B** — out of scope for a first pass, but the `.describe()` criteria anchors are prompt surface with no variant mechanism. Worth a follow-up change?
6. **Tool-loop route** — commit to promptfoo OTLP tracing (one tool, heavier setup) or add a small evalite/`node:test` harness (two tools, lighter)? Recommendation: the latter, deferred until the sweep + verdict gate are green.
7. **Determinism budget** — how many `--repeat` runs, and is a mock-model deterministic subset enough for the PR gate with real-model runs reserved for nightly?
8. **Where eval code lives** — `packages/code-reviewer/eval/` (this blueprint) vs a new `packages/code-reviewer-evals` package vs repo-root `eval/`. The in-package layout keeps barrel imports relative and config resolution intact.

---

## Sources (alternatives research)

- promptfoo custom provider API — https://www.promptfoo.dev/docs/providers/custom-api/
- promptfoo config reference — https://www.promptfoo.dev/docs/configuration/reference/
- promptfoo assertions — https://www.promptfoo.dev/docs/configuration/expected-outputs/ , .../javascript/ , .../model-graded/
- promptfoo evaluate-JSON guide — https://www.promptfoo.dev/docs/guides/evaluate-json/
- promptfoo tracing / trajectory assertions — https://www.promptfoo.dev/docs/tracing/
- promptfoo Vercel provider — https://www.promptfoo.dev/docs/providers/vercel/
- promptfoo node package usage — https://www.promptfoo.dev/docs/usage/node-package/
- promptfoo CI/CD + GitHub Action — https://www.promptfoo.dev/docs/integrations/ci-cd/ , https://github.com/promptfoo/promptfoo-action
- promptfoo engines — https://github.com/promptfoo/promptfoo/blob/main/package.json
- object-output assertion issue — https://github.com/promptfoo/promptfoo/issues/4014
- OpenAI × promptfoo (re-verify) — https://openai.com/index/openai-to-acquire-promptfoo/ , https://www.promptfoo.dev/blog/promptfoo-joining-openai/
- OpenAI Evals deprecation — https://community.openai.com/t/deprecation-notice-evals-will-be-shut-down-on-november-30th-2026/1385537
- evalite — https://www.evalite.dev/ , .../guides/scorers , .../guides/traces , .../guides/configuration , https://github.com/mattpocock/evalite
- autoevals — https://github.com/braintrustdata/autoevals , https://www.braintrust.dev/docs/start/eval-sdk
- DeepEval — https://deepeval.com/guides/guides-ai-agent-evaluation , https://deepeval.com/blog/typescript-in-deepeval-monorepo
- Langfuse — https://langfuse.com/docs/evaluation/overview , https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk
