# CI/CD Agentic Code Review — Implementation Plan

## Overview

Wire `packages/code-reviewer` into GitHub Actions so every pull request to `master` gets an
automated review: a PR comment with a six-criterion grade table plus itemized findings, and one of
three mutually-exclusive labels (`ai-cr:passed` / `ai-cr:failed` / `ai-cr:review`). The reviewer
already exists as a working `ToolLoopAgent`; this plan extends it to accept a diff-shaped input,
adds a pure verdict function, and adds the CI plumbing (a composite action + a workflow) around it.

## Current State Analysis

`packages/code-reviewer` reviews one target at a time — a file path or an inline string — through
`createCodeReviewer().review()`, and prints a human-readable report to a terminal. It has never been
called from anything but its own CLI. There is no `.github/` directory in the repository: this is
greenfield CI.

The package's design already anticipates this use case without being built for it: its public
barrel (`src/agent/index.ts`) is side-effect-free, every option needed for CI (`workspaceRoot`,
`maxSteps`, `timeout`, model id) is already a constructor option, and failures are typed
(`CodeReviewError` with three reasons) rather than silently degrading. What's missing is diff-shaped
input, a schema that matches the six-criterion rubric, and CI-clean stdout.

### Key Discoveries:

- `CodeReviewTarget` is a two-member union (`file` | `inline`) at
  `packages/code-reviewer/src/prompts/code-review.ts:45-47`. `buildCodeReviewPrompt` is an
  exhaustive `switch` with a declared `: string` return and no `default` — adding a third member
  without a matching `case` fails the build, not just a lint rule.
- `codeReviewSchema` (`packages/code-reviewer/src/schemas/code-review.ts:10-21`) has no `criteria`
  and no `file` field on a finding. `.describe()` annotations are prompt surface the model reads
  per-field — the rubric belongs there, not only in the instructions string.
- `packages/code-reviewer/src/utils/logger.ts:24` writes to `console.log`, the same stream
  `src/index.ts:36` prints the final review to. CI needs one clean channel; this is a one-line fix
  (`console.log` → `console.error`).
- Workspace root and package root are already decoupled: `createCodeReviewAgent` defaults
  `workspaceRoot` to `process.cwd()` (`code-review-agent.ts:77`), while `.env`/`config.json`/`logs/`
  are anchored to the module's own location via `import.meta.dirname`
  (`src/utils/paths.ts:4`). Running the reviewer with `cwd = $GITHUB_WORKSPACE` gets "config from the
  package, code from the checkout" for free — **but only if the CI entrypoint does not let `cwd`
  drift to `packages/code-reviewer` itself** (see Critical Implementation Details).
- `CodeReviewError` (`src/agent/errors.ts:7-13`) already has three reasons
  (`step-budget-exhausted`, `invalid-output`, `provider-error`) that map cleanly onto the grey
  `ai-cr:review` label — no new failure concept needed.
- The agent's tools cannot read `.git` (`skippedDirectories` in `workspace.ts:20`) and there is no
  shell tool — the diff must be produced by the workflow/action, never by the agent.
- `config.json` sets `maxSteps: 16`; a real single-file run took 11 steps
  (`context/changes/tool-loop-agent/plan-brief.md`). A multi-file diff needs headroom.
- `packages/code-reviewer` is not an npm workspace member of the repo root (`package.json` has no
  `workspaces` field); it carries its own lockfile, so CI must `npm ci` inside
  `packages/code-reviewer`, not at the repo root.
- Existing tests (`code-review-agent.test.ts`) construct reviewers with `MockLanguageModelV4` and
  call `reviewer.review({ kind: "file", ... })` directly — the same pattern extends cleanly to a
  `kind: "diff"` target and to a new CI-entrypoint test.

## Desired End State

Every PR opened, synchronized, or reopened against `master` triggers a workflow that: checks out the
PR, computes and caps its diff, runs the reviewer against `{ title, description, diff }`, posts a
single sticky PR comment with a grades table and findings grouped by file, and applies exactly one
of `ai-cr:passed` / `ai-cr:failed` / `ai-cr:review`. Adding the `ai-cr:review` label to an existing
PR re-runs the review. The job never blocks merging (advisory only) and never runs for fork PRs.

**Verification**: open a PR against `master` in this repo (or a throwaway branch) and confirm a
comment appears with a criteria table, exactly one `ai-cr:*` label is applied, pushing a new commit
updates the same comment instead of adding a new one, and adding the `ai-cr:review` label to a
already-reviewed PR triggers a fresh run.

## What We're NOT Doing

- Fork PR support (`pull_request_target`) — same-repo `pull_request` only, matching the current
  single-contributor repo. Revisit if external contributions start.
- Blocking/required-check behavior — the job always exits 0; grades are advisory, never a merge gate.
- Per-file review loops — one diff-level review per PR run, since four of the six criteria
  (idiomaticity, complexity, test coverage, documentation) are change-level properties a per-file
  loop cannot see.
- Publishing the composite action for reuse outside this repo, or packaging the reviewer for a
  registry — it stays a local path dependency consumed by a repo-local action.
- Business alignment and architectural fit criteria — explicitly parked in `requirements.md`.
- A configurable verdict threshold — the floor rule is hardcoded in the package, not exposed via
  `config.json`.
- Updating the terminal CLI (`src/cli/render.ts`, `src/index.ts`) to display the new `criteria`
  block — out of scope; the local CLI keeps working unchanged, just without grades in its output.

## Implementation Approach

Judgement lives in the TypeScript package (typed, unit-testable); side effects live in the
workflow YAML. Concretely:

- **Phase 1** extends the reviewer package itself: a `diff` target kind, the six-criterion schema,
  a pure `computeVerdict()` function, and the stdout fix. This is the part a type checker and
  `node:test` can verify without touching GitHub at all.
- **Phase 2** adds a small CI entrypoint script *in the package* that turns `{ title, description,
  diff }` inputs into `{ verdict, comment-path }` outputs — still pure TypeScript, still testable
  with `MockLanguageModelV4` the way `code-review-agent.test.ts` already does.
- **Phase 3** wraps that entrypoint in a composite action that owns `npm ci`, diff acquisition, and
  running the entrypoint — the part of the boundary the requirements call "easy to reason about."
- **Phase 4** is the calling workflow: triggers, permissions, label bootstrap, and the two real
  side effects (posting the comment, applying labels) that only make sense at the workflow level.

## Critical Implementation Details

**Workspace root must never be the CI entrypoint's own `cwd`.** If the composite action does
`cd packages/code-reviewer && npm ci && npx tsx src/ci.ts`, the reviewer's default
`workspaceRoot ?? process.cwd()` resolves to `packages/code-reviewer` itself — silently confining
the review to the reviewer's own source instead of the PR's code. The Phase 2 entrypoint must take
an **explicit** `--workspace <path>` argument (the action passes `$GITHUB_WORKSPACE`), never falling
back to `process.cwd()`. This is the single easiest thing to get wrong in the whole plan, per the
research findings.

**The diff cap is a hard character limit, not a token estimate.** Cap the diff text at **60,000
characters** (roughly 15-20k tokens — comfortably inside the model's context alongside the agent's
own tool reads, per the ~158k-input single-file baseline in `tool-loop-agent`'s plan brief) before it
ever reaches the prompt. Truncate with a visible marker (`\n\n[diff truncated at 60000 characters]`)
rather than silently dropping content, so a truncated review is distinguishable from a complete one
in the rendered output.

**`GITHUB_OUTPUT` is an append-only file, not an env var.** The CI entrypoint and the composite
action write `verdict=...` and `comment-path=...` as lines appended to the file at
`process.env.GITHUB_OUTPUT`, not printed to stdout — this is the GitHub Actions v2 outputs
mechanism and the only way a composite action step's outputs reach `steps.<id>.outputs.*`.

## Phase 1: Reviewer Core — Diff Target, Criteria Schema, Verdict

### Overview

Extend the package's typed core so it can review a diff and grade it against the six requirements
criteria, without touching anything CI-specific yet. Every change in this phase is covered by
`node:test` using the existing `MockLanguageModelV4` pattern.

### Changes Required:

#### 1. Diff-shaped review target

**File**: `packages/code-reviewer/src/prompts/code-review.ts`

**Intent**: Add a third `CodeReviewTarget` kind so the agent can be pointed at a PR diff instead of
a single file, and build a prompt for it that inlines the diff (the agent cannot reconstruct it —
`.git` is off-limits) while still pointing the agent at `readFile`/`search` for surrounding context
the diff hunks don't show.

**Contract**: Add `{ kind: "diff"; title: string; description?: string; diff: string }` to the
`CodeReviewTarget` union, and a matching `case "diff":` in `buildCodeReviewPrompt`'s switch (the
compiler enforces this — the existing switch has no `default` and a `: string` return). The new
branch's message includes the PR title, the description when present, and the diff fenced as
` ```diff `, followed by an instruction to read any file the diff touches (via `readFile`) for
context before judging it, and to name the affected `file` on every finding.

#### 2. Criteria + file-attributed findings schema

**File**: `packages/code-reviewer/src/schemas/code-review.ts`

**Intent**: Replace the ad hoc severity-only schema with the six graded criteria from
`requirements.md`, and make every finding attributable to a file so findings on a multi-file diff
stay placeable.

**Contract**: Add a `file: z.string().describe(...)` field to `findingSchema` (required — every
finding names the file it applies to, even for single-file targets). Add a `criterionSchema =
z.object({ grade: z.number().int().min(1).max(10), justification: z.string() })`, with the grade's
`.describe()` carrying that criterion's 1/10 and 10/10 anchors verbatim from the requirements table
(this is prompt surface, per the existing `.describe()` discipline). Add a `criteriaSchema` object
with exactly six named fields — `implementationCorrectness`, `idiomaticity`, `complexity`,
`testCoverage`, `documentation`, `securityAndSafety` — each a `criterionSchema`. Add `criteria:
criteriaSchema` to `codeReviewSchema` alongside the existing `summary` and `findings`. Export
`Criteria`/`Criterion` types alongside the existing `Finding`/`CodeReview` types.

#### 3. Verdict computation

**File**: `packages/code-reviewer/src/agent/verdict.ts` (new)

**Intent**: A pure, unit-testable function that turns six grades into the pass/fail decision the
workflow needs, per the accepted floor rule.

**Contract**: `export function computeVerdict(criteria: Criteria): "passed" | "failed"`. Fails when
any criterion's `grade <= 4`, or when `criteria.securityAndSafety.grade <= 6`; passes otherwise.
No I/O, no knowledge of labels or GitHub — the workflow-facing label string mapping happens in
Phase 3/4, not here.

#### 4. Markdown rendering for the PR comment

**File**: `packages/code-reviewer/src/cli/render-markdown.ts` (new)

**Intent**: Render a `CodeReview` as the PR comment body: a criteria grade table, then findings
grouped by file. This is the "markdown rendering belongs in the package, not in bash" principle from
research — typed, testable, reusable by both the CI entrypoint and its tests.

**Contract**: `export function renderReviewMarkdown(review: CodeReview): string`. Output shape: an
`## AI Code Review` heading, a Markdown table of the six criteria (name, grade, one-line
justification), the `summary`, then findings grouped under a `### <file>` heading each, listing
line/severity/title/explanation/suggestion. When `findings` is empty, state "No findings." The
comment-identity marker (see Phase 4) is *not* added here — that's a workflow-level concern, added
when the comment is posted.

#### 5. Stop polluting stdout

**File**: `packages/code-reviewer/src/utils/logger.ts`

**Intent**: Make stdout a clean, parseable channel for CI by moving logs to stderr; Actions logs
still capture stderr in full, so nothing is lost.

**Contract**: Line 24, `console.log(line)` → `console.error(line)`. No other change.

#### 6. Raise the step budget

**File**: `packages/code-reviewer/config.json`

**Intent**: A diff touching several files, each read for context, needs more than the 16-step budget
sized for single-file reviews.

**Contract**: `maxSteps: 16` → `maxSteps: 40`. (`requestTimeoutMs` stays `120000`; total budget
becomes `120000 * 40` = 80 minutes of *ceiling*, bounded in practice by the workflow's job-level
`timeout-minutes` in Phase 4 — see Critical Implementation Details.)

#### 7. Pin the Node engine

**File**: `packages/code-reviewer/package.json`

**Intent**: The package needs Node ≥ 20.12 for `process.loadEnvFile`; state that as an executable
constraint instead of only in the Readme, so `actions/setup-node` in Phase 3 has something to match.

**Contract**: Add `"engines": { "node": ">=20.12" }` alongside the existing top-level fields.

#### 8. Public barrel exports

**File**: `packages/code-reviewer/src/agent/index.ts`

**Intent**: Make the new target constructor, verdict function, and markdown renderer available to
the Phase 2 CI entrypoint through the same side-effect-free barrel every other consumer uses.

**Contract**: Add `diffTarget(title: string, diff: string, description?: string): CodeReviewTarget`
next to the existing `fileTarget`/`inlineTarget` convenience functions in `code-review-agent.ts`,
and re-export it plus `computeVerdict` and `renderReviewMarkdown` (and the new `Criteria`/`Criterion`
types) from the barrel.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck --prefix packages/code-reviewer`
- Unit tests pass: `npm test --prefix packages/code-reviewer`
- Build succeeds: `npm run build --prefix packages/code-reviewer`

#### Manual Verification:

- `npm start --prefix packages/code-reviewer` still runs the sample inline review and prints a
  human-readable report with no regression (criteria block simply isn't shown by the terminal
  renderer, which is unchanged).

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before proceeding
to the next phase.

---

## Phase 2: CI Entrypoint

### Overview

A small script, still inside `packages/code-reviewer`, that turns `{ workspace, title, description,
diff }` into `{ verdict, comment-path }` — the seam the composite action will call in Phase 3. Kept
in the package (not the action) so it's covered by the same `node:test` + `MockLanguageModelV4`
pattern as the rest of the reviewer.

### Changes Required:

#### 1. CI entrypoint script

**File**: `packages/code-reviewer/src/ci.ts` (new)

**Intent**: Bridge diff-review inputs (read from CLI flags, since GitHub Actions passes step inputs
as command-line arguments or env vars, not stdin) to the reviewer, then to a verdict and a rendered
comment file — mirroring `src/index.ts`'s split between argument parsing and the reviewer call, but
producing files/outputs instead of a terminal report.

**Contract**: Exports a testable `runCi(options: { workspace: string; title: string; description?:
string; diff: string; commentPath: string; maxSteps?: number }): Promise<{ verdict: "passed" |
"failed" | "review"; commentPath: string }>` that:
- builds `diffTarget(options.title, options.diff, options.description)`,
- calls `createCodeReviewer({ workspaceRoot: options.workspace, maxSteps: options.maxSteps
  }).review(target)`,
- on success, computes the verdict via `computeVerdict` and writes `renderReviewMarkdown(review)` to
  `options.commentPath`,
- on a `CodeReviewError`, sets `verdict: "review"` and writes a short markdown fallback naming
  `error.reason` and `error.message` (never a stack trace — that belongs in the Actions log, not the
  PR) to `options.commentPath`,
- never throws — a review that could not conclude still produces a `"review"` verdict and a comment,
  matching the advisory decision.

A thin `main()` (parsing `process.argv`/`process.env`, matching `index.ts`'s existing pattern) calls
`runCi`, writes `verdict=<value>` and `comment-path=<value>` as appended lines to the file at
`process.env.GITHUB_OUTPUT` (per Critical Implementation Details), and always sets `process.exitCode
= 0`. The `--workspace` flag is required with no `process.cwd()` fallback (unlike `index.ts`'s local
CLI) — a missing value is a `main()`-level error, not a silent default.

#### 2. Wire an npm script

**File**: `packages/code-reviewer/package.json`

**Intent**: Give the composite action a stable command to invoke, consistent with the existing
`"start": "tsx src/index.ts"` pattern.

**Contract**: Add `"scripts.ci": "tsx src/ci.ts"`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck --prefix packages/code-reviewer`
- Unit tests pass: `npm test --prefix packages/code-reviewer` (new tests cover: a passing verdict, a
  failing verdict via a low grade, a `CodeReviewError` producing a `"review"` verdict, and that
  `runCi` never throws)

#### Manual Verification:

- Running `OPENROUTER_API_KEY=<key> npx tsx src/ci.ts --workspace <repo-root> --title "test"
  --diff-file <path-to-a-small-diff> --comment-path /tmp/comment.md --output /tmp/gh-output` from
  inside `packages/code-reviewer` produces a non-empty `/tmp/comment.md` with a criteria table and a
  `verdict=` line in `/tmp/gh-output`.

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before proceeding
to the next phase.

---

## Phase 3: Composite Action

### Overview

`.github/actions/ai-code-review/` — everything mechanical: install, fetch and cap the diff, run the
Phase 2 entrypoint, expose its outputs. No label or comment logic here; that stays in Phase 4's
workflow so the action remains a reusable "review → verdict" unit.

### Changes Required:

#### 1. Action definition

**File**: `.github/actions/ai-code-review/action.yml` (new)

**Intent**: Declare the composite action's contract — what it needs (API key, GitHub token, PR
number) and what it produces (`verdict`, `comment-path`), so the workflow in Phase 4 stays a short,
declarative caller.

**Contract**: `runs.using: "composite"`. Inputs: `openrouter-api-key` (required — composite actions
have no `secrets` context, so the workflow must pass it explicitly), `github-token` (required, for
the `gh` calls this action makes), `pr-number` (required). Outputs: `verdict` (`value: ${{
steps.review.outputs.verdict }}`), `comment-path` (`value: ${{ steps.review.outputs.comment-path
}}`). Every `run:` step declares `shell: bash`.

#### 2. Action steps

**File**: `.github/actions/ai-code-review/action.yml` (same file, `runs.steps`)

**Intent**: Set up Node at the version the package now declares in `engines`, install only the
reviewer package (not an npm-workspace install — there is none), acquire the diff via the GitHub API
(sidestepping `actions/checkout`'s shallow-clone depth entirely, per research), cap it, and hand
everything to `npm run ci`.

**Contract**: Steps, in order:
1. `actions/setup-node@v4` with `node-version: 22` (research: `engines` states `>=20.12`, but the
   Readme and prior `tool-loop-agent` work already target 22 — pin the runner to match).
2. `npm ci` with `working-directory: packages/code-reviewer` (relative to `${{
   github.action_path }}/../../..`, i.e. the checked-out repo — **not** `$GITHUB_ACTION_PATH`, since
   the action's own files live outside the checkout in some invocation modes; use `working-directory:
   ${{ github.workspace }}/packages/code-reviewer`).
3. A `run:` step that calls `gh pr view ${{ inputs.pr-number }} --json title,body` and `gh pr diff
   ${{ inputs.pr-number }}` (both authenticated via `env: { GH_TOKEN: ${{ inputs.github-token } }`),
   truncates the diff text to 60,000 characters with the marker from Critical Implementation
   Details, and writes title/description/diff to temp files (avoids multi-line values going through
   shell variables).
4. A `run:` step, `id: review`, that runs `npm run ci --prefix packages/code-reviewer -- --workspace
   "$GITHUB_WORKSPACE" --title-file <path> --description-file <path> --diff-file <path>
   --comment-path "$RUNNER_TEMP/ai-review-comment.md"`, with `OPENROUTER_API_KEY: ${{
   inputs.openrouter-api-key }}` in `env:`. This is the step whose `GITHUB_OUTPUT` writes (from
   Phase 2's `main()`) become `steps.review.outputs.*`.

### Success Criteria:

#### Automated Verification:

- `action.yml` is valid composite-action YAML (no automated linter configured yet — verified
  manually per below; if `actionlint` is available, `actionlint .github/actions/ai-code-review/action.yml`)

#### Manual Verification:

- Push a branch with this action added and confirm via the Actions UI that a workflow step using
  `uses: ./.github/actions/ai-code-review` (a throwaway test workflow, or Phase 4's real one) runs
  end-to-end and produces `verdict`/`comment-path` outputs visible in the run's step summary.

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before proceeding
to the next phase.

---

## Phase 4: Workflow — Trigger, Labels, Comment, Retry

### Overview

The calling workflow: decides when to run, sets up permissions, ensures the three labels exist,
calls Phase 3's action, and owns the two real side effects — the sticky PR comment and the
mutually-exclusive label swap.

### Changes Required:

#### 1. Workflow triggers and job shell

**File**: `.github/workflows/ai-code-review.yml` (new)

**Intent**: Run on every PR event that changes the diff or requests a retry, guarded so unrelated
label additions don't trigger a run, and bounded so a runaway review can't burn a runner-hour.

**Contract**: `on.pull_request: { branches: [master], types: [opened, synchronize, reopened,
labeled] }`. Job-level `if: github.event.action != 'labeled' || github.event.label.name ==
'ai-cr:review'`. Job-level `permissions: { contents: read, pull-requests: write }`. Job-level
`concurrency: { group: ai-cr-${{ github.event.pull_request.number }}, cancel-in-progress: true }`.
Job-level `timeout-minutes: 20`. A code comment above `on:` noting that this trigger's safety
against self-retriggering depends on `GITHUB_TOKEN` — the guarantee breaks if a PAT or app token is
ever substituted in.

#### 2. Label bootstrap

**File**: `.github/workflows/ai-code-review.yml` (same file, a step before the review runs)

**Intent**: `gh pr edit --add-label` fails on a label the repo doesn't have; make label creation
idempotent so this workflow is self-sufficient on a fresh repo.

**Contract**: Three `gh label create <name> --color <hex> --force` calls (idempotent — safe to
re-run) for `ai-cr:passed` (green, e.g. `#2ea44f`), `ai-cr:failed` (red, e.g. `#d73a4a`), and
`ai-cr:review` (grey, e.g. `#9e9e9e`), authenticated via `env: { GH_TOKEN: ${{ github.token } }`.

#### 3. Checkout and the review step

**File**: `.github/workflows/ai-code-review.yml` (same file)

**Intent**: Get the PR code onto the runner, then call Phase 3's action with the secrets it needs.

**Contract**: `actions/checkout@v4` with `ref: ${{ github.event.pull_request.head.sha }}` (the merge
commit is not what's under review). Then `uses: ./.github/actions/ai-code-review` with `id: review`,
`with: { openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}, github-token: ${{ secrets.GITHUB_TOKEN
}}, pr-number: ${{ github.event.pull_request.number }} }`.

#### 4. Sticky comment

**File**: `.github/workflows/ai-code-review.yml` (same file)

**Intent**: One comment per PR, updated in place across pushes — not one per push. Implemented via
the HTML-marker approach (no `gh` CLI version dependency, per the accepted decision).

**Contract**: A step using `actions/github-script@v7` (or an equivalent `gh api` sequence) that:
reads the comment body from `steps.review.outputs.comment-path`, prepends a hidden marker
(`<!-- ai-code-review-comment -->`), lists existing PR comments via the REST API, finds one authored
by `github-actions[bot]` containing that marker, and either `PATCH`es it or creates a new one via
`POST` when none is found.

#### 5. Label application

**File**: `.github/workflows/ai-code-review.yml` (same file)

**Intent**: Exactly one `ai-cr:*` label on the PR at any time, mapped from `steps.review.outputs.verdict`.

**Contract**: A step that maps `verdict` (`passed`|`failed`|`review`) to its label name, then a
single `gh pr edit ${{ github.event.pull_request.number }} --add-label <chosen> --remove-label
<other-two, comma-separated>` call (removing labels that may not be present is a no-op for `gh`, not
an error).

### Success Criteria:

#### Automated Verification:

- `action.yml`/workflow YAML parses (`actionlint .github/workflows/ai-code-review.yml` if available)

#### Manual Verification:

- Open a real PR against `master` in this repo: confirm the three labels get created on first run,
  a PR comment appears with the criteria table, exactly one `ai-cr:*` label is applied matching the
  comment's verdict, a follow-up push edits the same comment rather than adding a new one, and adding
  the `ai-cr:review` label to an already-reviewed PR triggers a fresh run that updates the comment
  and label again.
- Confirm a PR from a fork does **not** trigger the workflow (or fails cleanly with no secrets
  exposed) — matching the same-repo-only decision.

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful. This is the
final phase.

---

## Testing Strategy

### Unit Tests:

- `computeVerdict`: passes on all-high grades; fails on a single criterion ≤4; fails on
  `securityAndSafety` ≤6 even when every other grade is 10; passes at exactly the boundary (5, and
  security at 7).
- `buildCodeReviewPrompt` for the new `diff` kind: includes title, description when present, omits
  the description block when absent, fences the diff.
- `renderReviewMarkdown`: groups findings by file, renders the criteria table, handles zero findings.
- `runCi`: a `MockLanguageModelV4` returning a passing review produces `verdict: "passed"` and a
  comment file; a low-grade review produces `"failed"`; a schema-violating response (via
  `CodeReviewError`) produces `"review"` and never throws.

### Integration Tests:

- None automated in this plan — the composite action and workflow are verified manually against a
  real PR (Phase 3 and Phase 4 manual verification), since GitHub Actions execution isn't
  reproducible in the package's `node:test` suite.

### Manual Testing Steps:

1. Open a small, deliberately imperfect PR against `master` (e.g. a function with an off-by-one) and
   confirm the review catches it and a low `implementationCorrectness` grade drives `ai-cr:failed`.
2. Open a clean PR and confirm `ai-cr:passed` with no findings.
3. Push a second commit to an already-reviewed PR and confirm the comment updates in place.
4. Add the `ai-cr:review` label manually to a passed PR and confirm a fresh run fires and the label
   flips back to a real verdict.
5. Confirm a fork-originated PR (if testable) does not run the workflow.

## Performance Considerations

- `maxSteps: 40` at `requestTimeoutMs: 120000` gives an 80-minute theoretical ceiling; the workflow's
  `timeout-minutes: 20` is the real backstop.
- The 60,000-character diff cap keeps worst-case input bounded regardless of PR size; a PR larger
  than that gets a truncated review rather than a failed run.
- `concurrency: { cancel-in-progress: true }` avoids paying for N reviews on N rapid pushes to the
  same PR.

## Migration Notes

Not applicable — this is new infrastructure with no existing data or prior workflow to migrate from.

## References

- Related research: `context/changes/ci-cd-code-review/research.md`
- Requirements: `context/changes/ci-cd-code-review/requirements.md`
- Prior design record for the reviewer: `context/changes/tool-loop-agent/plan-brief.md`
- Current target union: `packages/code-reviewer/src/prompts/code-review.ts:45-47`
- Current schema: `packages/code-reviewer/src/schemas/code-review.ts:10-21`
- Existing test pattern to follow: `packages/code-reviewer/src/agent/code-review-agent.test.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not
> rename step titles. See `references/progress-format.md`.

### Phase 1: Reviewer Core — Diff Target, Criteria Schema, Verdict

#### Automated

- [x] 1.1 Type checking passes: `npm run typecheck --prefix packages/code-reviewer`
- [x] 1.2 Unit tests pass: `npm test --prefix packages/code-reviewer`
- [x] 1.3 Build succeeds: `npm run build --prefix packages/code-reviewer`

#### Manual

- [x] 1.4 `npm start --prefix packages/code-reviewer` still runs the sample inline review with no regression

### Phase 2: CI Entrypoint

#### Automated

- [ ] 2.1 Type checking passes: `npm run typecheck --prefix packages/code-reviewer`
- [ ] 2.2 Unit tests pass: `npm test --prefix packages/code-reviewer` (verdict mapping + never-throws coverage)

#### Manual

- [ ] 2.3 Manual `tsx src/ci.ts` run produces a comment file and a `verdict=` output line

### Phase 3: Composite Action

#### Automated

- [ ] 3.1 `action.yml` validates (actionlint if available)

#### Manual

- [ ] 3.2 A test workflow invoking the action end-to-end produces `verdict`/`comment-path` outputs

### Phase 4: Workflow — Trigger, Labels, Comment, Retry

#### Automated

- [ ] 4.1 Workflow YAML validates (actionlint if available)

#### Manual

- [ ] 4.2 Real PR: labels bootstrap, comment posted, correct single label applied
- [ ] 4.3 Push to same PR updates the existing comment instead of adding a new one
- [ ] 4.4 Adding `ai-cr:review` label triggers a fresh run and updates comment + label
- [ ] 4.5 Fork PR does not trigger the workflow
