# `eval/` — promptfoo eval for the code-review agent

v1: run the real code-review agent over one fixture — a React 16→19 migration
diff with three embedded correctness bugs (`fixtures/react19-migration/`) — across
several models plus a deterministic mock, and score each run.

## Run it

```bash
cd packages/code-reviewer
npm run eval
```

That does `npm run build` → `npm run eval:schema` (regenerates
`schemas/code-review.schema.json` from the Zod schema) → `promptfoo eval`, and
writes `eval-results.json` + `eval-results.html` in the package root. Open the
HTML report directly, or run `npx promptfoo view` for the interactive UI.

### API key

Real-model columns and the g-eval judge need `OPENROUTER_API_KEY` in
`packages/code-reviewer/.env` (promptfoo loads `.env` from its cwd). Without a
key, only the `mock` column produces meaningful scores — that's expected.

Mock-only, no key required — the deterministic column, `schema_valid` +
`review_fails` only:

```bash
npm run eval:mock          # uses eval/promptfooconfig.mock.yaml
```

`promptfoo eval -c eval/promptfooconfig.yaml --filter-providers mock` also
selects just the mock column, but it still runs the `g-eval` assertion (which
needs the judge key) so the row is marked failed without one.

## The three scores (report columns)

| Metric | Assertion | Model? | Meaning |
| --- | --- | --- | --- |
| `schema_valid` | `is-json` vs `schemas/code-review.schema.json` | no | the review parses and matches the generated JSON Schema |
| `review_fails` | `asserts/review-fails.mjs` | no | `computeVerdict(criteria) === "failed"` **and** `findings.length >= 3` |
| `finding_recall` | `g-eval`, threshold `0.67` | yes (judge) | fraction of the 3 golden flaws the review identified; passes at 2/3 |

`review_fails` is the deterministic gate — `promptfoo eval` exits non-zero if it
fails for any row. `finding_recall` is advisory.

The `mock` column is fully deterministic: its canned review fails the verdict
with three findings that name all three flaws, so `review_fails` is green and
`finding_recall` is 1.0 on every run (given a judge key).

## Non-determinism

The agent uses tools, so real-model runs are noisier than a single-shot call.
`evaluateOptions.repeat: 2` runs each row twice. If a `review_fails` /
`finding_recall` result flips between runs, re-run once before treating it as a
config bug rather than agent variance. `temperature` is pinned to 0.

## Extending

- **Add a model**: append a `providers` entry in `promptfooconfig.yaml` with a
  new `label` and `config.model` (an OpenRouter slug). The model slugs shipped
  in v1 (`anthropic/claude-sonnet-4.5`, `z-ai/glm-5.1`,
  `deepseek/deepseek-v4-flash`) should be checked against the live OpenRouter
  model list and adjusted as needed.
- **Swap the judge**: change `defaultTest.options.provider` to another
  `openrouter:` slug.
- **Add a fixture**: new directory under `fixtures/`, then a new list entry in
  `datasets/react19-migration.yaml` (or a new dataset file added to `tests:` in
  `promptfooconfig.yaml`) whose `diff` var is a `file://` path to its
  `change.diff`. **The path is resolved relative to the config dir (`eval/`)**,
  e.g. `file://fixtures/<name>/change.diff` — not relative to the dataset file.
  A `.jsonl` dataset file is silently skipped by promptfoo 0.122; use `.yaml`.

## Gotchas

- `diffTarget` runs `excludeDirectoryFromDiff(diff, "packages")` — any hunk whose
  path is under `packages/` is stripped before the model sees it. Fixture diffs
  must use non-`packages/` paths (`src/…`).
- `review()` throws on failure rather than returning a partial review; the
  provider catches it and returns `{ error }`, which legitimately fails
  `review_fails`.
- The `.mjs` assertion imports **compiled** `../../dist/agent/verdict.js`, so
  `npm run eval` builds first. Running `promptfoo eval` directly without a prior
  `npm run build` will fail that assertion.
- `schemas/`, `eval-results.*`, `.promptfoo/` and `output/` are git-ignored.
