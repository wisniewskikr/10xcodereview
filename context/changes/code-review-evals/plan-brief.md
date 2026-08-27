# code-review-evals — Plan Brief

> Full plan: `context/changes/code-review-evals/plan.md`
> Research: `context/changes/code-review-evals/research.md`

## What & Why

Stand up the first **promptfoo** configuration inside `packages/code-reviewer` so
the AI code-review agent can be run and scored against a fixed test case. The
package was deliberately built eval-ready (side-effect-free barrel, factory with
overrides, pure `computeVerdict`, mockable model) but has no harness, no fixture,
and no scoring. This change delivers the smallest useful one: one hard fixture,
three models, two kinds of check.

## Starting Point

`createCodeReviewer({ model, … }).review(target)` already returns a structured
`CodeReview` (`summary`, six graded `criteria`, `findings[]`), `computeVerdict`
already maps criteria → `passed`/`failed`, `diffTarget` already builds a PR-review
target, and the existing tests already inject `MockLanguageModelV4`. Nothing calls
any of it from an eval. promptfoo is not installed; there is no `eval/` directory
and no fixture corpus (only a throwaway `sampleCode` snippet in `src/index.ts`).

## Desired End State

From `packages/code-reviewer`, `npm run eval` builds the package, regenerates a
JSON Schema from the Zod schema, and runs a promptfoo sweep: **four providers**
(`anthropic/claude-sonnet-4.5`, `z-ai/glm-5.1`, `deepseek/deepseek-v4-flash`, and
a deterministic `mock`) over **one dataset row** — a complex React 16→19 migration
diff with three embedded correctness bugs — twice each. Every run is scored by a
deterministic assertion (`computeVerdict === "failed"` **and** `findings.length >=
3`) and by an LLM judge (`g-eval`, one step per known flaw, pass at ≥ 2/3),
producing an HTML report with a `finding_recall` column per model. `npm test`
gains an offline test that exercises the whole provider path via the mock.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Eval tool | promptfoo, in-package `packages/code-reviewer/eval/` | Research pick; keeps barrel imports relative and `config.json`/`.env` resolution intact | Research |
| Models under test | `anthropic/claude-sonnet-4.5`, `z-ai/glm-5.1`, `deepseek/deepseek-v4-flash` (OpenRouter slugs) | The three the user named; `model` option already takes a slug string | Plan |
| Judge model | An external model via OpenRouter (`openrouter:openai/gpt-5` default, swappable) | Avoids the reviewer grading its own family | Plan |
| Judge scoring | `g-eval`, one criterion per golden flaw, `finding_recall` metric, threshold 0.67 | Per-flaw visibility with the least custom code; directly answers "did it find what's broken" | Plan |
| The three flaws | (1) stale-closure counter update racing React 19 automatic batching; (2) `useEffect` subscription with no cleanup; (3) `useEffect` dep array omitting a value it reads | All correctness-impacting, diff-visible, and worse under React 19 defaults; severe enough to force `verdict = failed` | Plan |
| Static assertion | `javascript` assert importing compiled `dist/agent/verdict.js`: verdict `failed` AND ≥ 3 findings | The "review actually fails" gate with no model; the CI-gatable check if CI is added later | Plan |
| Non-determinism | `repeat: 2` + a `mock` provider column + an offline `node:test` | Dampens agent noise; gives a deterministic pipeline path that needs no API key | Plan |
| Run mode | Local-only `npm run eval`; no CI workflow | Matches "first configuration"; no Actions secret / cache work | Plan |

## Scope

**In scope:**
- promptfoo devDep, `eval` / `eval:schema` scripts, `engines.node` → `>=20.20`.
- `eval/gen-schema.ts` → generated `code-review.schema.json`.
- One fixture: buggy post-migration component + `src/lib` stubs + `change.diff` +
  `expected-flaws.json` + fixture README + sanity test.
- `eval/provider.ts` (with a `mock: true` path), `promptfooconfig.yaml`,
  `eval/asserts/review-fails.mjs`, the dataset row, an offline provider test,
  `eval/README.md`.

**Out of scope:**
- CI / GitHub Actions, nightly runs.
- Prompt-variant sweep (only `default`), multi-fixture corpus.
- Tool-loop / trajectory assertions, OTLP tracing, `experimental_telemetry`.
- Per-case token/cost capture; any change to `createCodeReviewer`'s surface.
- Re-tuning `computeVerdict` thresholds; a second eval framework.

## Architecture / Approach

`eval/` sits inside the package. A custom TypeScript promptfoo **provider** wraps
`createCodeReviewer`, reads the diff/vars from `context.vars`, calls
`review(diffTarget(...))`, and returns `JSON.stringify(review)` + `{ verdict,
findingCount }` metadata (or `{ error }` on a thrown `CodeReviewError`). The model
sweep is four `providers` entries pointing at the same file with different
`config`. Scoring lives in `defaultTest.assert`: `is-json` against the generated
schema, a deterministic `javascript` assert (`review-fails.mjs`, imports compiled
`dist/`), and a `g-eval` judge whose steps come from `expected-flaws.json`.
`npm run eval` = `build → gen-schema → promptfoo eval`, so the `.mjs` assert and
the provider run on the same compiled artifacts.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Scaffolding | promptfoo installed, `eval`/`eval:schema` scripts, Node bump, generated JSON Schema | `z.toJSONSchema` output shape not matching what `is-json` expects; Node < 20.20 on a dev box |
| 2. Fixture | React 16→19 diff with three real bugs, golden flaw list, README, sanity test | Flaws too obvious (no model discrimination) or too subtle (verdict doesn't fail); an accidental fourth bug in the "benign" changes |
| 3. Provider + config + run | `provider.ts`, `promptfooconfig.yaml`, `review-fails.mjs`, dataset, offline test, README, working `npm run eval` | promptfoo's TS loader vs the package's `nodenext`/`.js` specifiers; OpenRouter slug names; `g-eval` judge flakiness |

**Prerequisites:** Node ≥ 20.20 locally; `OPENROUTER_API_KEY` in
`packages/code-reviewer/.env` for real-model runs (the mock path and both
`node:test`s need no key).
**Estimated effort:** ~2–3 focused sessions, one per phase; Phase 2 (writing a
convincing buggy migration) is the most hand-work.

## Open Risks & Assumptions

- **Exact OpenRouter slugs** for the three models must be confirmed against the
  live model list at implementation time; `sonnet-4.5` is read as
  `anthropic/claude-sonnet-4.5`.
- **promptfoo's TypeScript provider loader** is assumed to handle the package's
  ESM `nodenext` style; the plan mitigates by importing compiled `../dist/…` from
  the provider (build always runs first).
- **`g-eval` judge** results will vary run to run; the metric is advisory and
  `repeat: 2` plus a re-run are the only smoothing. Not a hard gate beyond its own
  threshold.
- **Agent non-determinism**: a real-model `review_fails` result can flip between
  runs; the `mock` column is the stable anchor.
- **`diffTarget` strips `packages/**` hunks** — the fixture diff must stay under
  `src/`; a sanity-test grep guards this.

## Success Criteria (Summary)

- `npm run eval` produces an HTML + JSON report with four columns and, on a
  real-key run, a `finding_recall` value per model, exiting non-zero iff any
  deterministic `review_fails` assertion failed.
- The `mock` column is green and `finding_recall` = 1.0 on every run; both
  `node:test`s pass offline in `npm test`.
- A React-literate reviewer confirms the three fixture flaws are real,
  correctness-impacting, and identifiable from the diff.
