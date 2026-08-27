# code-review-evals — promptfoo v1: React 16→19 migration eval

## Overview

Introduce **promptfoo** inside `packages/code-reviewer` as a first, minimal eval
configuration. It runs the existing code-review agent over **one** fixture — a
"rather complex" diff migrating a React 16 class component to React 19 hooks with
**three impactful, embedded correctness bugs** — across **three OpenRouter
models** plus a deterministic mock provider, and scores each run two ways:

1. **Static (deterministic) assertion** — `computeVerdict(review.criteria) === "failed"`
   **and** `review.findings.length >= 3`. This is the "does the review actually
   fail" check, no model in the loop.
2. **LLM-as-a-judge** — a `g-eval` assertion with one step per known flaw, graded
   by an external model (via OpenRouter), passing when ≥ 2 of 3 flaws are
   identified. Emits a `finding_recall` metric per model column.

Local-only: invoked as `npm run eval` from `packages/code-reviewer`. No CI wiring
in this change. `repeat: 2` to dampen agent non-determinism.

## Current State Analysis

The package was deliberately built eval-ready (see `research.md`). The relevant
facts this plan depends on:

- **`src/agent/index.ts`** is a side-effect-free barrel. It exports
  `createCodeReviewer`, `computeVerdict`, `codeReviewSchema`, `diffTarget` /
  `fileTarget` / `inlineTarget`, `CodeReviewTarget`, and the prompt-variant record.
- **`createCodeReviewer({ model, promptVariant, workspaceRoot, temperature, maxSteps, … })`**
  → `{ agent, review }`. `review(target)` returns `CodeReview` =
  `{ summary, criteria (6 × {grade 1-10, justification}), findings[] }`.
  `model` accepts an OpenRouter slug **or** an injected `LanguageModel` (a mock).
  On failure `review()` throws `CodeReviewError` — it never returns a partial review.
  (`src/agent/code-review-agent.ts:53-59, 109-148`)
- **`computeVerdict(criteria)`** → `"passed" | "failed"`; fails if any grade ≤ 4,
  or `securityAndSafety.grade` ≤ 6. Pure, exported. (`src/agent/verdict.ts:8-20`)
- **`diffTarget(title, diff, description?)`** runs
  `excludeDirectoryFromDiff(diff, "packages")` — **hunks under `packages/` are
  stripped before the model sees them.** The fixture diff therefore must use
  non-`packages/` paths (e.g. `src/components/…`). (`src/agent/code-review-agent.ts:170-190`)
- **`codeReviewSchema`** (`src/schemas/code-review.ts`) has zero AI-SDK imports and
  can be turned into JSON Schema with `z.toJSONSchema` (zod 4.4.3 is installed).
- **Config**: `config.json` at the package root (default model
  `anthropic/claude-sonnet-5`, `temperature` 0, `maxSteps` 40). `getConfig()` is
  lazy + memoized. `OPENROUTER_API_KEY` is read from `packages/code-reviewer/.env`
  by `createReviewModel` via `process.loadEnvFile` (`src/services/model.ts:11-19`,
  `src/utils/env.ts`). `fromProjectRoot` resolves two levels up from
  `src/utils/` **or** `dist/utils/` → always the package root.
- **Tooling**: ESM `nodenext`, TypeScript 7, Node built-in test runner
  (`node --import tsx --test "src/**/*.test.ts"`). `npm run build` = `tsc` with
  `include: ["src"]`, `outDir: dist` — so `eval/` is **not** compiled by `build`;
  `dist/agent/verdict.js` and `dist/schemas/code-review.js` **are** produced.
- **`engines.node`** is `>=20.12`; promptfoo's floor is `^20.20.0 || >=22.22.0`.
- The existing tests already inject `MockLanguageModelV4` from `ai/test` via
  `createCodeReviewer({ model })` (`src/agent/code-review-agent.test.ts:6,36-80`).
- No promptfoo installed. No npm workspaces. `packages/code-reviewer/.gitignore`
  exists (`node_modules/ dist/ logs/*.log .env`). No `context/foundation/roadmap.md`.

## Desired End State

From `packages/code-reviewer`, with `OPENROUTER_API_KEY` set in `.env`:

- `npm run eval` builds the package, regenerates the JSON schema, and runs the
  promptfoo sweep: **4 providers** (`sonnet-4.5`, `glm-5.1`, `deepseek-v4-flash`,
  `mock`) × **1 dataset row** × `repeat: 2`, writes `eval-results.json` and an
  HTML report, and exits non-zero if any **static** assertion fails.
- Each report row shows: `schema_valid` (is-json vs generated schema),
  `review_fails` (verdict `failed` + ≥ 3 findings), and `finding_recall`
  (g-eval, 0–1, threshold 0.67).
- The `mock` provider column is fully deterministic: its canned review fails the
  verdict with 3 findings that name all three flaws → `review_fails` green,
  `finding_recall` = 1.0.
- `npm test` includes `eval/provider.test.ts`, a fully offline `node:test` that
  calls the provider with `{ mock: true }` and asserts the returned review fails
  the verdict with ≥ 3 findings — the pipeline check that needs no API key.
- `npm run typecheck` and `npm run build` stay green.

### Key Discoveries

- `diffTarget` strips `packages/**` hunks — fixture diff must live under a
  different path prefix (`src/components/UserActivityFeed.tsx`).
- `review()` throws rather than returning a partial — the provider must catch and
  return `{ error }`, and a thrown review legitimately fails `review_fails`.
- `buildCodeReviewPrompt` is **not** barrel-exported; the provider uses
  `reviewer.review(target)` and therefore cannot surface `result.usage` — per-case
  token cost is out of scope for v1 (`research.md` §3.2).
- `.mjs` assertion files can't be TypeScript (`research.md` §2.4) — the static
  assert imports **compiled** `../../dist/agent/verdict.js`, so `npm run eval`
  must `npm run build` first.
- promptfoo loads `.env` from its cwd, so running from `packages/code-reviewer`
  gives both the custom provider (real reviewer) and the `openrouter:` judge the
  same key.

## What We're NOT Doing

- No GitHub Actions / CI gate, no nightly job, no promptfoo GitHub Action.
- No prompt-variant sweep (only the `default` variant). The mechanism is there;
  this fixture doesn't exercise it.
- No multi-fixture corpus — exactly one dataset row (the React migration diff).
- No tool-loop / trajectory assertions, no OTLP tracing, no `experimental_telemetry`.
- No per-case token/cost capture; no change to `createCodeReviewer`'s surface.
- No re-tuning of `computeVerdict`'s 4 / 6 thresholds.
- No `evalite` / `autoevals` / second framework.
- No change to the reviewer's runtime behaviour, prompts, schema, or `config.json`.

## Implementation Approach

`eval/` lives **inside** `packages/code-reviewer` so the custom provider imports
the barrel by relative path and `config.json` / `.env` resolution is unchanged.
The custom TypeScript provider wraps `createCodeReviewer` and returns
`JSON.stringify(review)` so string-consuming assertions work. Model sweeping is
done as multiple `providers` entries pointing at the same provider file with
different `config` — the "one immutable reviewer per config" idiom the package was
designed for. Deterministic checks are plain `javascript` assertions importing
compiled `dist/`; the soft "are the findings any good" check is `g-eval` and is
kept advisory (threshold, not a hard gate beyond its own pass/fail).

## Critical Implementation Details

- **Build ordering.** `npm run eval` = `npm run build && npm run eval:schema &&
  promptfoo eval …`. The `.mjs` static assert imports `../../dist/agent/verdict.js`
  and `eval/gen-schema.ts` imports `../dist/schemas/code-review.js`; both require a
  prior `tsc`.
- **`diffTarget` path prefix.** Every `+++`/`---` path in `change.diff` must be
  outside `packages/` or `excludeDirectoryFromDiff` deletes the hunk and the model
  reviews nothing. Use `src/components/…` and `src/lib/…`.
- **Workspace root.** The provider passes `workspaceRoot` =
  absolute path to `eval/fixtures/react19-migration` so the agent's `readFile` /
  `search` tools resolve the files the diff touches (the post-migration component
  and its `src/lib` stubs must exist there on disk).
- **StrictMode framing in the fixture.** Two of the three flaws are materially
  worse under React 19's default double-invoke / automatic batching — the flaw
  descriptions and the `g-eval` steps must name that so the judge credits a review
  that explains the React-19-specific failure mode.

## Phase 1: Scaffolding — deps, scripts, generated schema

### Overview

Make promptfoo installable and runnable, and produce the JSON Schema the
`is-json` assertion validates against. No eval logic yet.

### Changes Required

#### 1. Package manifest

**File**: `packages/code-reviewer/package.json`

**Intent**: Add promptfoo as a dev dependency, add the eval scripts, and raise the
Node floor to promptfoo's minimum.

**Contract**:
- `devDependencies`: add `"promptfoo"` (latest 0.x).
- `engines.node`: `">=20.12"` → `">=20.20"`.
- `scripts`: add
  - `"eval:schema": "tsx eval/gen-schema.ts"`
  - `"eval": "npm run build && npm run eval:schema && promptfoo eval -c eval/promptfooconfig.yaml -o eval-results.json"`
- `test` script unchanged — it already globs `src/**/*.test.ts`; the eval smoke
  test is added to that glob in Phase 3 by living at `eval/provider.test.ts`…
  **note**: `src/**` will not match `eval/**`. Update `test` to
  `node --import tsx --test "src/**/*.test.ts" "eval/**/*.test.ts"`.

#### 2. Schema generator

**File**: `packages/code-reviewer/eval/gen-schema.ts` (new)

**Intent**: Emit the code-review JSON Schema from the Zod schema so the
`is-json` assertion has a file to validate against; regenerated on every
`npm run eval` so it can never drift.

**Contract**: imports `codeReviewSchema` from `../dist/schemas/code-review.js`,
writes `z.toJSONSchema(codeReviewSchema, { target: "draft-7" })` (pretty-printed
JSON) to `eval/schemas/code-review.schema.json`. Creates `eval/schemas/` if
absent. Exits non-zero on write failure.

#### 3. Ignore generated / run artifacts

**File**: `packages/code-reviewer/.gitignore`

**Intent**: Keep promptfoo output and the derived schema out of git.

**Contract**: append `eval-results.json`, `eval/schemas/`, `.promptfoo/`,
`eval/output/`.

### Success Criteria

#### Automated Verification

- `npm install` in `packages/code-reviewer` succeeds with promptfoo present:
  `npx promptfoo --version` prints a version.
- `npm run build` succeeds (unchanged).
- `npm run eval:schema` creates `eval/schemas/code-review.schema.json` and it is
  valid JSON containing a `properties.criteria` object.
- `npm run typecheck` passes.
- `git status --porcelain eval/schemas` shows the generated file is ignored.

#### Manual Verification

- The generated schema, eyeballed, has all six criteria and the `findings` array
  shape (`file`, `line` nullable, `severity` enum, `title`, `explanation`,
  `suggestion`).

**Implementation Note**: After automated verification passes, pause for manual
confirmation before Phase 2.

---

## Phase 2: Fixture — the React 16→19 migration diff with three flaws

### Overview

Author the single eval fixture: a realistic, non-trivial migration diff whose
three embedded bugs are correctness-impacting and visible from the change, plus
the golden flaw list and a sanity test.

### Changes Required

#### 1. Post-migration component (on disk for the tool loop)

**File**: `packages/code-reviewer/eval/fixtures/react19-migration/src/components/UserActivityFeed.tsx` (new)

**Intent**: The React 19 function-component version of a live activity feed,
containing the three flaws below and otherwise-correct migration work (class →
function, `this.setState` → `useState`, `PropTypes` → TS props). This is the file
the diff's post-image points at, so the agent can `readFile` it for full context.

**Contract**: a `UserActivityFeed({ userId }: { userId: string })` component that:
- keeps `events` and `unread` in `useState`;
- **Flaw 1 — stale-closure counter racing automatic batching**: `markOneRead`
  (and `markAllRead`) do `setUnread(unread - 1)` / rely on the render-time
  `unread` **after** `await api.markRead(userId)`. React 19 batches this async
  update with concurrent `activityStream` increments; the stale base drops
  increments that land during the await. Correct form is a functional updater.
  (The class version read `this.state.unread` at call time.)
- **Flaw 2 — `useEffect` subscription with no cleanup**: the effect calls
  `activityStream.subscribe(userId, cb)` (which returns an unsubscribe fn) keyed
  on `[userId]` but **returns nothing**. Old subscriptions leak on every `userId`
  change and on unmount; React 19 StrictMode's double-invoke creates two live
  subscriptions at mount.
- **Flaw 3 — stale `useEffect` dependency array**: a second effect reads
  `events[0].id` to call `api.persistLastSeen(userId, …)` but its dep array is
  `[userId]`, omitting `events` — so it only ever runs with the mount-time empty
  `events` and the server "last seen" marker never advances.
- Renders the list and an unread badge (enough JSX to be plausible).

#### 2. Supporting stubs

**File**: `packages/code-reviewer/eval/fixtures/react19-migration/src/lib/activity-stream.ts`,
`.../src/lib/api.ts` (new)

**Intent**: Thin, correct stubs so the agent's `readFile` / `search` on the
imports resolve to real code rather than dead ends.

**Contract**: `activityStream.subscribe(userId: string, cb: (evt: ActivityEvent) => void): () => void`;
`api.markRead(userId): Promise<void>`, `api.persistLastSeen(userId, eventId): Promise<void>`.
`ActivityEvent` = `{ id: string; kind: string; at: string }`.

#### 3. The migration diff

**File**: `packages/code-reviewer/eval/fixtures/react19-migration/change.diff` (new)

**Intent**: A unified diff (as it would appear in a PR) that removes the React 16
class implementation and adds the hooks version, touching enough surface
(`UserActivityFeed.tsx`, a sibling `index.tsx` moving `ReactDOM.render` →
`createRoot`, `package.json` React bump 16→19) to read as a real migration.

**Contract**: valid `diff --git` unified format; **all paths under `src/`, none
under `packages/`**; the post-image of `UserActivityFeed.tsx` matches the file
from change #1 byte-for-byte. Include benign, correct changes alongside the three
flaws so the flaws are not the only deltas.

#### 4. Golden flaw list

**File**: `packages/code-reviewer/eval/fixtures/react19-migration/expected-flaws.json` (new)

**Intent**: The machine- and human-readable source of truth for what a correct
review must catch; feeds the `g-eval` step wording and documents the fixture.

**Contract**: JSON array of exactly 3 objects, each
`{ id, file, lineHint, title, whyImpactful, react19Note, detectionHint }`.
`file` is `src/components/UserActivityFeed.tsx` for all three.

#### 5. Fixture README

**File**: `packages/code-reviewer/eval/fixtures/react19-migration/README.md` (new)

**Intent**: Prose explanation of the scenario and each flaw (the before/after
shape, the failure in practice, why React 19 makes it worse), so a maintainer can
adjust the fixture without reverse-engineering it.

**Contract**: one section per flaw, cross-referenced to `expected-flaws.json` ids.

#### 6. Fixture sanity test

**File**: `packages/code-reviewer/eval/fixtures.test.ts` (new)

**Intent**: Cheap guard that the fixture is well-formed before any model call.

**Contract**: `node:test` asserting — `expected-flaws.json` parses to an array of
length 3 with unique ids; `change.diff` is non-empty, contains no `+++ b/packages/`
path, and mentions `useEffect`; the component and stub files exist and are
non-empty.

### Success Criteria

#### Automated Verification

- `npm test` runs `eval/fixtures.test.ts` and it passes.
- `node -e "require('...').length"` style check (or the test) confirms exactly 3
  golden flaws.
- `grep -c '^\+\+\+ b/packages/' eval/fixtures/react19-migration/change.diff` → 0.
- `npm run typecheck` still passes (fixture `.tsx` is outside `src/`, so it must
  not break the build — confirm `tsc` include is still `["src"]`).

#### Manual Verification

- A React-literate reader confirms each of the three flaws is real, is
  correctness-impacting (not style), and is identifiable from the diff alone.
- The diff reads as a plausible, "rather complex" migration, not a toy.
- The three benign changes are genuinely correct (no accidental fourth bug).

**Implementation Note**: Pause for manual confirmation of the fixture before Phase 3.

---

## Phase 3: Provider, promptfoo config, assertions, and end-to-end run

### Overview

Wire the reviewer into promptfoo, define the four providers and the two scoring
assertions, and get `npm run eval` producing a report.

### Changes Required

#### 1. Custom provider

**File**: `packages/code-reviewer/eval/provider.ts` (new)

**Intent**: Bridge promptfoo's "prompt → provider" model to the agent's
structured `target`. Reads the dataset row from `context.vars`, builds a reviewer
from the provider's `config`, runs `review()`, returns the review as a JSON
string plus metadata.

**Contract**: `export default class CodeReviewerProvider implements ApiProvider`.
- `constructor(options: ProviderOptions)` — stores `options.id` and
  `options.config` (`{ model?, promptVariant?, mock?, maxSteps? }`).
- `id()` → the label.
- `async callApi(_prompt, context)`:
  - `mock: true` → `createCodeReviewer({ model: <MockLanguageModelV4 returning a
    canned failing CodeReview that names all three flaws>, workspaceRoot })`.
  - otherwise → `createCodeReviewer({ model: this.config.model, workspaceRoot:
    <abs path to eval/fixtures/react19-migration>, temperature: 0,
    maxSteps: this.config.maxSteps })`.
  - `target = diffTarget(vars.title, String(vars.diff), vars.description)`.
  - on success → `{ output: JSON.stringify(review), metadata: { verdict:
    computeVerdict(review.criteria), findingCount: review.findings.length } }`.
  - on thrown `CodeReviewError` / any error → `{ error: \`code-reviewer failed:
    ${message}\` }` (return, don't throw).
- Imports from `../src/agent/index.js` are acceptable (promptfoo's loader handles
  `.ts`), but prefer `../dist/agent/index.js` since `npm run eval` always builds
  first — keeps the provider on the same compiled artifacts as the `.mjs` assert.

#### 2. Static assertion

**File**: `packages/code-reviewer/eval/asserts/review-fails.mjs` (new)

**Intent**: The deterministic "the review actually fails" gate — no model.

**Contract**: default-exports `(output, context) => GradingResult`. Parses
`output` as JSON (missing/`error` output → `{ pass: false }`), computes
`computeVerdict(review.criteria)` via `import` of
`../../dist/agent/verdict.js`, and returns
`pass = verdict === "failed" && Array.isArray(review.findings) && review.findings.length >= 3`,
`score` 1/0, a `reason` naming which condition failed, and
`namedScores: { review_fails: pass ? 1 : 0 }`.

#### 3. promptfoo config

**File**: `packages/code-reviewer/eval/promptfooconfig.yaml` (new)

**Intent**: Tie providers, the one dataset row, and the assertions together.

**Contract**:
- `description`: "code-reviewer — React 16→19 migration eval (v1)".
- `prompts: ["{{diff}}"]` — passthrough; the provider ignores it.
- `providers`: four entries, all `id: file://./provider.ts`, distinct `label`s:
  - `sonnet-4.5`   → `config: { model: anthropic/claude-sonnet-4.5 }`
  - `glm-5.1`      → `config: { model: z-ai/glm-5.1 }`
  - `deepseek-v4-flash` → `config: { model: deepseek/deepseek-v4-flash }`
  - `mock`         → `config: { mock: true }`
  - (exact OpenRouter slugs to be confirmed against the live model list at
    implementation time; `anthropic/claude-sonnet-4.5` is the intended reading of
    "sonnet-4.5".)
- `defaultTest.options.provider: openrouter:openai/gpt-5` — the external judge for
  `g-eval` (different family from the Anthropic model under test; swap to another
  `openrouter:` slug if unavailable). Judge runs at `temperature: 0`.
- `defaultTest.assert`:
  - `type: is-json`, `value: file://./schemas/code-review.schema.json`,
    `metric: schema_valid`.
  - `type: javascript`, `value: file://./asserts/review-fails.mjs`,
    `metric: review_fails`.
  - `type: g-eval`, `metric: finding_recall`, `threshold: 0.67`, `value:` a
    3-item list — one criterion per golden flaw, each phrased as "The review
    identifies …" and naming the React-19-specific failure mode from
    `expected-flaws.json`.
- `tests: [ file://./datasets/react19-migration.jsonl ]`.
- `evaluateOptions: { maxConcurrency: 3, repeat: 2 }`.

#### 4. Dataset row

**File**: `packages/code-reviewer/eval/datasets/react19-migration.jsonl` (new)

**Intent**: The single eval case.

**Contract**: one JSON line: `vars` = `{ title: "Migrate UserActivityFeed from a
React 16 class component to React 19 hooks", description: <1–2 sentences>, diff:
"file://../fixtures/react19-migration/change.diff" }`. No per-row `assert` (all
scoring is in `defaultTest`). Path to the diff is relative to the dataset file.

#### 5. Offline pipeline test

**File**: `packages/code-reviewer/eval/provider.test.ts` (new)

**Intent**: Prove the provider → review → verdict path works with no network,
in the normal `npm test` run.

**Contract**: `node:test` — imports the provider default export, instantiates it
with `{ config: { mock: true } }`, calls `callApi("", { vars: { title, description,
diff: <read change.diff> } })`, parses `output`, and asserts
`computeVerdict(review.criteria) === "failed"` and `review.findings.length >= 3`
and `metadata.verdict === "failed"`.

#### 6. Eval README

**File**: `packages/code-reviewer/eval/README.md` (new)

**Intent**: How to run and extend the eval.

**Contract**: covers — `OPENROUTER_API_KEY` in `packages/code-reviewer/.env`;
`npm run eval` and what it writes; how to read `schema_valid` / `review_fails` /
`finding_recall`; how to add a model (new `providers` entry), swap the judge, or
add a fixture (new dir + dataset line); the known non-determinism (`repeat: 2`,
re-run to confirm a flip); that `packages/**` diff paths are stripped by
`diffTarget`.

### Success Criteria

#### Automated Verification

- `npm test` passes, including `eval/provider.test.ts` and `eval/fixtures.test.ts`.
- `npm run typecheck` passes.
- `npm run eval` with **no** `OPENROUTER_API_KEY`: the `mock` provider row
  completes; `schema_valid` and `review_fails` are green for it;
  `eval-results.json` is written. (Real-model rows error on the missing key —
  acceptable; the run still produces a report.)
- `npm run eval` with a valid `OPENROUTER_API_KEY`: all four providers run,
  `repeat: 2` is honoured (8 provider executions), the HTML report shows a
  `finding_recall` column, and the process exit code is 0 iff every `review_fails`
  assertion passed.
- `promptfoo eval -c eval/promptfooconfig.yaml --filter-providers mock` runs only
  the deterministic column and its `review_fails` passes.

#### Manual Verification

- Open the HTML report: three real-model columns + `mock`, one row, per-cell
  `schema_valid` / `review_fails` / `finding_recall` visible and legible.
- On a real run, spot-check one model's raw findings against
  `expected-flaws.json` and confirm the `g-eval` verdict is reasonable (not
  obviously mis-graded).
- Re-run once; confirm any `review_fails` / `finding_recall` flip is understood as
  agent non-determinism, not a config bug.
- `mock` column: `finding_recall` = 1.0 and `review_fails` green on every run.

**Implementation Note**: Pause for manual confirmation after the end-to-end run.

---

## Testing Strategy

### Unit / offline (`npm test`, no network)

- `eval/fixtures.test.ts` — fixture well-formedness (3 golden flaws, no
  `packages/` paths in the diff, files present).
- `eval/provider.test.ts` — provider `{ mock: true }` path yields a review that
  fails the verdict with ≥ 3 findings.

### Integration (`npm run eval`)

- Mock-only: `--filter-providers mock` — deterministic `schema_valid` +
  `review_fails`.
- Full sweep with a real key — the matrix report; manual inspection of
  `finding_recall` against the golden list.

### Manual

1. `cd packages/code-reviewer && npm run eval` with a key set.
2. Open the generated HTML report; read the four columns.
3. Compare one model's findings to `eval/fixtures/react19-migration/expected-flaws.json`.
4. Re-run; confirm stability of `mock`, note any real-model flip.

## Migration Notes

`engines.node` moves to `>=20.20`. Confirm the local and any shared dev Node is
≥ 20.20 before merging (`node -v`). No data or runtime migration.

## References

- Research: `context/changes/code-review-evals/research.md` (esp. Part 1
  eval-readiness, Part 3 blueprint, §2.4 friction, §3.2 provider sketch).
- `packages/code-reviewer/src/agent/index.ts` — barrel exports.
- `packages/code-reviewer/src/agent/code-review-agent.ts:53-59,109-190` —
  `resolveModel` (mock injection), `createCodeReviewer`, `diffTarget` +
  `excludeDirectoryFromDiff`.
- `packages/code-reviewer/src/agent/verdict.ts:8-20` — `computeVerdict`.
- `packages/code-reviewer/src/schemas/code-review.ts` — `codeReviewSchema`.
- `packages/code-reviewer/src/agent/code-review-agent.test.ts:6,36-80` —
  `MockLanguageModelV4` injection pattern to mirror in the provider and mock.
- promptfoo custom provider — https://www.promptfoo.dev/docs/providers/custom-api/
- promptfoo assertions (`is-json`, `javascript`, `g-eval`) —
  https://www.promptfoo.dev/docs/configuration/expected-outputs/

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step
> lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Scaffolding — deps, scripts, generated schema

#### Automated

- [x] 1.1 `npm install` succeeds; `npx promptfoo --version` prints a version — 189c6a6
- [x] 1.2 `npm run build` succeeds (unchanged) — 189c6a6
- [x] 1.3 `npm run eval:schema` creates a valid `eval/schemas/code-review.schema.json` with a `properties.criteria` object — 189c6a6
- [x] 1.4 `npm run typecheck` passes — 189c6a6
- [x] 1.5 `git status --porcelain eval/schemas` shows the generated schema is ignored — 189c6a6

#### Manual

- [x] 1.6 Generated schema, eyeballed, has all six criteria and the full `findings` shape — 189c6a6

### Phase 2: Fixture — the React 16→19 migration diff with three flaws

#### Automated

- [x] 2.1 `npm test` runs `eval/fixtures.test.ts` and it passes
- [x] 2.2 `expected-flaws.json` parses to an array of exactly 3 unique-id objects
- [x] 2.3 `grep -c '^\+\+\+ b/packages/' change.diff` returns 0
- [x] 2.4 `npm run typecheck` still passes (fixture `.tsx` outside `src/` does not enter the build)

#### Manual

- [x] 2.5 React-literate reader confirms all three flaws are real, correctness-impacting, and diff-visible
- [x] 2.6 The diff reads as a plausible, "rather complex" migration
- [x] 2.7 The benign changes are correct — no accidental fourth bug

### Phase 3: Provider, promptfoo config, assertions, and end-to-end run

#### Automated

- [ ] 3.1 `npm test` passes, including `eval/provider.test.ts` and `eval/fixtures.test.ts`
- [ ] 3.2 `npm run typecheck` passes
- [ ] 3.3 `npm run eval` with no key: `mock` row completes, `schema_valid` + `review_fails` green for it, `eval-results.json` written
- [ ] 3.4 `npm run eval` with a valid key: all 4 providers run, `repeat: 2` honoured (8 executions), HTML report has a `finding_recall` column, exit code 0 iff every `review_fails` passed
- [ ] 3.5 `promptfoo eval … --filter-providers mock` runs only the deterministic column and `review_fails` passes

#### Manual

- [ ] 3.6 HTML report shows 3 real-model columns + `mock`, one row, per-cell `schema_valid` / `review_fails` / `finding_recall`
- [ ] 3.7 Spot-check one model's findings vs `expected-flaws.json`; `g-eval` grade is reasonable
- [ ] 3.8 Re-run once; `mock` stable, any real-model flip understood as non-determinism
