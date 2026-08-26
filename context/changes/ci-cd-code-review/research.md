---
date: 2026-08-26T11:14:11+02:00
researcher: Chris
git_commit: 8b742f79875b82c5c968cbf0046127b6a02813ac
branch: main
repository: wisniewskikr/10xcodereview
topic: "CI/CD agentic code review — what the codebase already gives us and what the requirements still demand"
tags: [research, codebase, github-actions, composite-action, code-reviewer, ci-cd]
status: complete
last_updated: 2026-08-26
last_updated_by: Chris
---

# Research: CI/CD agentic code review on GitHub Actions

**Date**: 2026-08-26 11:14 +02:00 (Europe/Warsaw)
**Researcher**: Chris
**Git Commit**: `8b742f79875b82c5c968cbf0046127b6a02813ac`
**Branch**: `main`
**Repository**: wisniewskikr/10xcodereview

## Research Question

What does the codebase already provide, and what has to be built, to satisfy
[`context/changes/ci-cd-code-review/requirements.md`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/context/changes/ci-cd-code-review/requirements.md):
a GitHub Actions workflow that runs an agentic code review on every PR to master, delegates the
review itself to a composite action, takes PR title + description + git diff as input, grades six
criteria 1–10, and reacts with a PR comment and one of three `ai-cr:*` labels — retriable on demand
by adding a label.

## Summary

**The hard part is already built; the gaps are shape, not substance.**
`packages/code-reviewer` is a working `ToolLoopAgent` reviewer with a realpath-enforced workspace
guard, read-only tools, typed failures and lifecycle tracing — 531 lines of tests behind the
security boundary. Nothing about it is hostile to CI. In particular, `utils/paths.ts` anchors
`config.json` / `.env` / `logs/` to the *package* directory via `import.meta.dirname`, while the
agent's workspace root defaults to `process.cwd()`. Those two roots are already decoupled, which is
exactly what a runner needs: the action can invoke the reviewer from `$GITHUB_WORKSPACE` and get
"config from the package, code under review from the checkout" for free.

**Five gaps stand between today's package and the requirements, and three of them are in the
reviewer, not in the YAML:**

1. **No diff input.** `CodeReviewTarget` is a two-member union — `file` or `inline`. There is no
   way to hand the agent a diff, a PR title, or a PR description.
2. **Wrong output shape.** The schema returns `{ summary, findings[] }` with a three-level
   `severity`. The requirements want six named criteria graded 1–10. There is also **no `file`
   field on a finding** — it was implicit when the target was one file, and it cannot stay implicit
   for a multi-file diff.
3. **Stdout is not machine-readable.** `logger.ts:24` writes every log line to `console.log`, the
   same channel the CLI prints the rendered review on (`index.ts:36`). Anything parsing stdout gets
   log lines mixed into it.
4. **The workflow needs a pass/fail rule that the requirements do not state.** Six grades must
   collapse to one of three labels; no threshold is specified.
5. **Fork PRs cannot work under a plain `pull_request` trigger** — no secrets, read-only token —
   so the trigger choice is a real security decision, not a detail.

Everything else — composite action mechanics, labels, sticky comments, retry-on-label — is
standard GitHub Actions surface with one genuinely pleasant property: **the retry loop is safe by
construction**, because events triggered by `GITHUB_TOKEN` do not start new workflow runs, so the
workflow labelling its own PR cannot retrigger itself.

## Detailed Findings

### 1. What exists today: the reviewer package

`packages/code-reviewer` was built by the `tool-loop-agent` change (commits `2b00df1` → `7c12f04`)
and is architecturally ready to be called by something other than a terminal.

**The public surface is already the right one.** `src/agent/index.ts` is a deliberately
side-effect-free barrel — importing it reads no `.env` and builds no model
([`src/agent/index.ts:1-34`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/agent/index.ts#L1-L34)).
A composite action can import `createCodeReviewer` and drive it directly instead of shelling out.

**Every knob the CI needs is a constructor option**, defaulting to `config.json`
([`src/agent/code-review-agent.ts:24-43`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/agent/code-review-agent.ts#L24-L43)) —
including `workspaceRoot`, which is what pins the agent to the PR checkout.

**Failures are typed and never look like clean reviews**
([`src/agent/errors.ts:7-13`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/agent/errors.ts#L7-L13)).
The three reasons map cleanly onto the requirement's grey label:

| `CodeReviewErrorReason` | Meaning in CI | Label |
| --- | --- | --- |
| `step-budget-exhausted` | Ran out of turns — inconclusive | `ai-cr:review` (grey) |
| `invalid-output` | Model answered off-schema | `ai-cr:review` (grey) |
| `provider-error` | OpenRouter/network failed | `ai-cr:review` (grey) |

That is a ready-made "grey = we could not conclude, retry me" semantics. The red/green split then
comes only from grades, never from infrastructure noise — which is the right separation.

### 2. Gap: no diff target (the biggest code change)

The target union has exactly two members
([`src/prompts/code-review.ts:45-47`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/prompts/code-review.ts#L45-L47)):

```ts
export type CodeReviewTarget =
  | { kind: "file"; path: string }
  | { kind: "inline"; fileName: string; code: string };
```

Adding a third member — something like
`{ kind: "diff"; title: string; description?: string; diff: string }` — is **compiler-guided**,
which makes it a low-risk change:

- `buildCodeReviewPrompt` ([`code-review.ts:56-79`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/prompts/code-review.ts#L56-L79))
  is a `switch` with no `default` and a declared `: string` return. Under `strictNullChecks` a new
  unhandled member makes the function fall through and TS errors ("lacks ending return statement").
- `code-review-agent.ts:112` narrows with `target.kind === "file" ? target.path : target.fileName`,
  which stops type-checking the moment a third kind exists.

Both spots will fail the build rather than silently misbehave. That is worth relying on.

**The prompt builder's existing design is directly reusable.** The `file` branch deliberately does
*not* inline the code, to force the agent to reach for its tools
([`code-review.ts:50-54`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/prompts/code-review.ts#L50-L54)).
A diff target should sit in between: **inline the diff** (the agent cannot reconstruct it — see
below) but keep pushing it to read the surrounding files with `readFile`/`search` for context the
diff hunks do not show.

**The diff must come from the workflow, not from the agent.** `.git` is in `skippedDirectories`
([`src/tools/workspace.ts:20`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/tools/workspace.ts#L20)),
and there is no shell tool by design. The agent physically cannot compute a diff. Good — that keeps
the security boundary intact and makes diff acquisition an explicit, cappable workflow step.

**On the requirement's cost question** ("pull request description (?? cost tradeoff)"): include it.
The `tool-loop-agent` plan brief records a real single-file run at **158,818 input + 5,132 output
tokens**. A PR description is typically a few hundred tokens — under 0.5% of that. The diff and the
agent's own tool reads dominate the bill by three orders of magnitude. Cap the *diff*, not the
description.

### 3. Gap: the output schema does not match the six criteria

Today ([`src/schemas/code-review.ts:10-21`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/schemas/code-review.ts#L10-L21)):

```ts
findingSchema = { line, severity: "info"|"warning"|"error", title, explanation, suggestion }
codeReviewSchema = { summary, findings[] }
```

Three concrete changes:

- **Add a `criteria` block** — six graded entries (implementation correctness, idiomaticity,
  complexity, test/risk coverage, documentation, security & safety), each `{ grade: 1..10,
  justification }`. `z.number().int().min(1).max(10)` gives schema-level enforcement; the model
  cannot return a 12 and slip through.
- **Add `file` to `findingSchema`.** It has no file field at all. Every finding on a multi-file
  diff is unplaceable without it — and unplaceable findings cannot become inline PR comments later.
- **Keep `.describe()` discipline.** The schema comment at
  [`code-review.ts:1-6`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/schemas/code-review.ts#L1-L6)
  is explicit that these annotations *are* prompt surface. The 1/10-vs-10/10 rubric from the
  requirements table belongs in `.describe()` on each grade, not only in the instructions — that is
  where the model actually reads it, per-field, at generation time.

`line` is already `nullable` for whole-file findings, which the "documentation" and "complexity"
criteria will need.

`Output.object({ schema: codeReviewSchema })` at
[`code-review-agent.ts:86`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/agent/code-review-agent.ts#L86)
picks up the new shape with no other change.

### 4. Gap: CI-shaped I/O

**Stdout is polluted.** `logger.ts:24` writes to `console.log`:

```ts
function write(level: Level, message: string): void {
  const line = `[${timestamp(now)}] [${level}] ${message}`;
  console.log(line);            // <-- stdout
  ...
}
```

and `index.ts:36` prints the rendered review to the same stream. **The one-line fix is
`console.log` → `console.error`.** Logs stay fully visible in the Actions log (stderr is captured),
and stdout becomes a clean channel the action can redirect to a file and parse. Any alternative
(a `--json <path>` flag, a `GITHUB_OUTPUT` writer) is strictly more work for the same result.

**The workspace root already lands in the right place.** `createCodeReviewAgent` uses
`options.workspaceRoot ?? process.cwd()`
([`code-review-agent.ts:77`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/agent/code-review-agent.ts#L77))
and the CLI never overrides it. Meanwhile `fromProjectRoot` is anchored to the module's own
location, **not** to cwd:

```ts
export const projectRoot = resolve(import.meta.dirname, "..", "..");
```
([`src/utils/paths.ts:4`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/utils/paths.ts#L4))

So running the reviewer **with cwd = `$GITHUB_WORKSPACE`** gives config, `.env` and `logs/` from the
package and code-under-review from the checkout — no new flag needed. Running it *from* the package
directory (the naive `cd packages/code-reviewer && npm start`) would silently scope the agent to the
reviewer's own source. **This is the single easiest thing to get wrong in the action.** A `--workspace`
CLI flag would make the intent explicit rather than positional-cwd-dependent; worth considering.

**Secrets already work the CI way.** `loadEnvFile` no-ops when `.env` is absent and `requireEnv`
falls back to the shell environment
([`src/utils/env.ts:5-17`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/utils/env.ts#L5-L17)).
Passing `OPENROUTER_API_KEY` as a step `env:` is sufficient — no file to write.

**Install shape.** The root `package.json` is still the `hello-world-ts` starter with **no
`workspaces` field**, and `packages/code-reviewer` carries its own `package-lock.json`. This is not
an npm workspace: the action must `npm ci` **inside `packages/code-reviewer`**. There is also **no
`engines` field**, though the code needs Node ≥ 20.12 for `process.loadEnvFile` and the Readme says
22+. Pin `node-version: 22` in `actions/setup-node` and consider adding `engines` so the constraint
is stated somewhere executable.

**`npm start` runs from TypeScript via `tsx`** — no build step needed in CI, which keeps the action
short. `npm run build` exists if a compiled path is ever preferred.

### 5. The GitHub Actions surface (nothing exists yet)

There is **no `.github/` directory** in the repository. This change is greenfield CI.

**Composite action mechanics** (confirmed against current GitHub docs):

- `action.yml` with `runs: using: "composite"`; **every `run` step must declare `shell:`**.
- Bundled scripts are referenced through `${{ github.action_path }}` / `$GITHUB_ACTION_PATH`.
- Outputs are declared at the top level and wired to a step: `value: ${{ steps.x.outputs.y }}`.
- **Composite actions have no `secrets` context.** The OpenRouter key must be an explicit `input`
  passed by the workflow. Same for the token if the action does any `gh` calls.

**Recommended boundary** — this is what makes the calling workflow "easy to reason about", per the
requirement:

| Lives in the composite action | Lives in the workflow |
| --- | --- |
| setup-node + `npm ci` | triggers, `permissions`, `concurrency` |
| fetch & cap the diff | `actions/checkout` |
| run the reviewer | ensure labels exist |
| render markdown | post/update the PR comment |
| emit `verdict` + `comment-path` outputs | apply/remove the three labels |

Keeping the *side effects* in the workflow and the *judgement* in the action means the action is
reusable and dry-runnable, and the workflow reads as "review → comment → label" in ten lines. The
alternative (side effects inside the action) makes the workflow shorter still but couples the
action to one repo's label vocabulary.

**Markdown rendering belongs in the package, not in bash.** `src/cli/render.ts` is terminal-shaped
([`render.ts:4-23`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/cli/render.ts#L4-L23)).
Add a sibling markdown renderer exported from the barrel — a grades table plus grouped findings —
so the comment body is produced by typed, testable code rather than `jq` in a `run:` block.

### 6. Side effects: comment and labels

**Labels must already exist.** GitHub's own labelling tutorial states it outright: `gh pr edit
--add-label` fails on a label the repo does not have. The requirement specifies colours (red/green/
grey), so the workflow needs a bootstrap step — `gh label create <name> --color <hex> --force` is
idempotent and safe to run every time.

**The three labels are mutually exclusive.** Applying one must remove the other two, or a PR that
first failed and then passed carries both. `gh pr edit --add-label X --remove-label Y,Z` in one call.

**Permissions.** `permissions: { contents: read, pull-requests: write }` at job level. Per GitHub's
workflow-syntax reference, `pull-requests: write` covers adding labels; if the labels API 403s
against the PR-as-issue endpoint, add `issues: write`. Set permissions at **job** level so
everything unlisted is `none`.

**Sticky comment, not comment spam.** Every `synchronize` push re-runs the review; N pushes must not
mean N comments. Two options: `gh pr comment --edit-last` (edits the last comment by the same actor
— `github-actions[bot]`, which is what `GITHUB_TOKEN` posts as), or find-by-HTML-marker via the REST
API and PATCH it. **Verify `--edit-last` behaviour when no prior comment exists** on the runner's
`gh` version before relying on it — the flag needs a companion create-if-missing behaviour, and its
availability varies by version. The marker-based approach has no such dependency.

**Naming inconsistencies in the requirements to settle before implementation.** The label strings
appear three times with two different spellings each — `ai-cr:failed` / `ad-cr:passed` and
`ai-cr:review` / `ai-r:review`. These are exact-match strings in the retry `if:` guard, the
`gh label create` bootstrap and the `gh pr edit` call; a typo makes retry silently never fire.
Assume `ai-cr:failed`, `ai-cr:passed`, `ai-cr:review` unless told otherwise.

### 7. Retry on label — safe by construction

Trigger shape:

```yaml
on:
  pull_request:
    branches: [master]
    types: [opened, synchronize, reopened, labeled]
```

guarded so the `labeled` action only proceeds for the retry label:

```yaml
if: github.event.action != 'labeled' || github.event.label.name == 'ai-cr:review'
```

**The obvious infinite-loop worry does not apply.** GitHub does not start new workflow runs from
events triggered by `GITHUB_TOKEN`. The workflow applying `ai-cr:review` to its own PR therefore
cannot retrigger itself. **This guarantee is lost the moment a PAT or GitHub App token is
substituted for `GITHUB_TOKEN`** — worth a comment in the YAML, because it is the kind of thing a
later "let's use an app token" change breaks silently and expensively.

Add `concurrency: { group: ai-cr-${{ github.event.pull_request.number }}, cancel-in-progress: true }`
so a rapid push sequence does not run three paid reviews in parallel.

### 8. Fork PRs: the one real security decision

Per GitHub's docs on workflows in forked repositories: for a fork-originated `pull_request`,
**secrets are not passed to the runner and `GITHUB_TOKEN` is read-only**. Under a plain
`pull_request` trigger, a fork PR therefore fails twice over — no OpenRouter key, and no permission
to comment or label.

Two viable answers:

| Option | Consequence |
| --- | --- |
| **`pull_request`, same-repo only** | Simple and safe. Fork PRs get no review. Fine if this repo takes no external contributions. |
| **`pull_request_target`** | Full secrets and a read/write token; the workflow file is read from the base branch. Requires care. |

If `pull_request_target` is chosen, the non-negotiables are: never run fork-authored code — install
dependencies with `npm ci --ignore-scripts`, and install the *reviewer* from the base ref, not from
the PR head; check out the PR head only as **data** for the agent to read. The reviewer's own design
helps here — its tools are read-only and root-confined
([`workspace.ts:105-152`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/tools/workspace.ts#L105-L152))
and `.env` is denied by name
([`workspace.ts:62-67`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/tools/workspace.ts#L62-L67)) —
but note that the OpenRouter key is in `process.env`, not in a file, so the guard does not cover it.
The residual risk is prompt injection: a fork's diff is attacker-controlled text going into a model
whose output drives a `gh` command. Keep the model's output confined to the structured schema and
never interpolate it into a shell command.

**Recommendation: start with `pull_request`.** The requirement says "every new pull request to
master" with no mention of forks; this repo has a single contributor. Revisit if that changes.

### 9. Budget: `maxSteps` will need raising

`config.json` sets `maxSteps: 16`, `maxOutputTokens: 8000`, `requestTimeoutMs: 120000`,
`model: anthropic/claude-sonnet-5`. The `tool-loop-agent` epilogue records a **single-file** review
finishing in **11 steps**. A diff touching six files, with the agent reading each file plus its
callers, will not fit in 15 tool steps — and running out is not graceful: it throws
`step-budget-exhausted` and produces nothing
([`code-review-agent.ts:122-136`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/agent/code-review-agent.ts#L122-L136)).

Note also that the total timeout is *derived*: `totalMs = perCallTimeoutMs * maxSteps`
([`code-review-agent.ts:95`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/packages/code-reviewer/src/agent/code-review-agent.ts#L95)) —
so raising `maxSteps` to 40 also raises the ceiling to 80 minutes of wall clock. Give the *job* an
explicit `timeout-minutes` so a runaway review cannot burn a runner hour.

Also cap the diff itself. `gh pr diff` on a large PR returns megabytes; feed that in unbounded and
the run fails on context length after paying for it. Truncate with an explicit marker, and consider
falling back to `gh pr diff --name-only` plus tool-driven reading when the diff exceeds the cap —
the agent can read the files itself, which is the whole point of the tool loop.

**Diff acquisition, concretely.** `actions/checkout` defaults to `fetch-depth: 1`, so a local
`git diff base...HEAD` has no base commit to compare against without `fetch-depth: 0`. `gh pr diff
<number>` is an API call and sidesteps the checkout depth question entirely — prefer it.

## Code References

- `packages/code-reviewer/src/prompts/code-review.ts:45-47` — the two-member `CodeReviewTarget` union; where a `diff` kind goes
- `packages/code-reviewer/src/prompts/code-review.ts:56-79` — `buildCodeReviewPrompt`; exhaustive switch that will fail the build on a new kind
- `packages/code-reviewer/src/schemas/code-review.ts:10-21` — the review schema; needs `criteria[]` and a `file` field on findings
- `packages/code-reviewer/src/agent/code-review-agent.ts:24-43` — `CodeReviewAgentOptions`; every CI-relevant knob
- `packages/code-reviewer/src/agent/code-review-agent.ts:77` — workspace root defaults to `process.cwd()`
- `packages/code-reviewer/src/agent/code-review-agent.ts:95` — total timeout derived as `perCall * maxSteps`
- `packages/code-reviewer/src/agent/code-review-agent.ts:112` — file/inline narrowing that a third kind breaks
- `packages/code-reviewer/src/agent/errors.ts:7-13` — the three failure reasons → the grey label
- `packages/code-reviewer/src/utils/paths.ts:4` — project root anchored to `import.meta.dirname`, decoupled from cwd
- `packages/code-reviewer/src/utils/logger.ts:24` — `console.log` puts logs on stdout; change to `console.error`
- `packages/code-reviewer/src/utils/env.ts:5-17` — `.env` optional, shell env works; CI needs no file
- `packages/code-reviewer/src/tools/workspace.ts:20` — `.git` skipped, so the agent cannot compute a diff
- `packages/code-reviewer/src/tools/workspace.ts:62-67` — `.env` denied by name
- `packages/code-reviewer/src/tools/workspace.ts:105-152` — realpath containment, the security boundary
- `packages/code-reviewer/src/cli/render.ts:4-23` — terminal renderer; a markdown sibling is needed
- `packages/code-reviewer/src/index.ts:29` — CLI pre-validates the path before spending a model call
- `packages/code-reviewer/config.json` — `maxSteps: 16`, likely too low for a multi-file diff
- `packages/code-reviewer/package.json` — own lockfile, no `engines`, no root `workspaces` entry

## Architecture Insights

- **The cwd/package-root split is the load-bearing CI property.** Config follows the module,
  workspace follows the process. Built for evals, it happens to be exactly the shape a runner needs.
- **The type system is the migration plan.** Both the union and its consumers fail to compile on a
  new target kind. The diff feature can be driven by `tsc` errors rather than by grep.
- **Errors already encode "inconclusive".** The grey label needs no new concept — it is
  `CodeReviewError`, and red/green comes only from grades. Infrastructure noise never becomes a
  verdict.
- **Tool-only, read-only, root-confined is what makes a fork review even discussable.** The agent
  cannot exfiltrate or execute; the residual risk is prompt injection into the *output*, which is
  contained by keeping that output inside a Zod schema and out of any shell interpolation.
- **`.describe()` is prompt surface.** The six-criterion rubric should live on the schema fields,
  where the model reads it per-field, not only in the instruction string.
- **Judgement in the action, side effects in the workflow.** That split is what actually delivers
  the requirement's "main workflow is easy to reason about".

## Historical Context (from prior changes)

- [`context/changes/tool-loop-agent/plan-brief.md`](https://github.com/wisniewskikr/10xcodereview/blob/8b742f79875b82c5c968cbf0046127b6a02813ac/context/changes/tool-loop-agent/plan-brief.md) —
  the design record for the current reviewer. Directly relevant here:
  - **"git/diff review" was explicitly out of scope** for that change. This change is the follow-up
    it anticipated.
  - **Cost measurement**: a real single-file run cost ~158k input + 5k output tokens across 11
    steps — the basis for the "include the PR description, cap the diff" conclusion above.
  - **"Workspace root defaults to `process.cwd()`"** was logged as an open assumption. In CI it
    becomes a correctness requirement, not an assumption.
  - **"Tool use makes runs less deterministic"** — noted then as an eval concern; in CI it means a
    green PR can go red on a re-run with no code change. Relevant to how the grade threshold is set.
  - The reviewer was built with an eval harness in mind. The composite action is the *second*
    consumer of the barrel, which is what the barrel was for.
- `context/foundation/` holds only its README — there is no tech-stack, PRD, or lessons document
  yet, so no cross-change priors constrain this work.

## Related Research

None. This is the first research artifact in the repository; `context/changes/tool-loop-agent/`
contains a plan and brief but no `research.md`.

## Open Questions

1. **Grade → label threshold.** Six 1–10 grades must become red/green. Minimum-grade cutoff?
   Weighted average? A hard floor on Security & Safety specifically? A suggested starting rule:
   fail on any criterion ≤ 4, or Security & Safety ≤ 6. Needs a decision before implementation.
2. **Fork PRs: in or out?** `pull_request` (simple, same-repo only) vs `pull_request_target`
   (works for forks, demands care). Recommendation above is `pull_request`.
3. **One review per diff, or one per changed file?** Four of the six criteria (idiomaticity,
   complexity, test coverage, documentation) are change-level properties that a per-file loop cannot
   see — which argues for a single diff-level review. Per-file would give tighter context and better
   line numbers at several times the cost.
4. **Should the action be reusable outside this repo?** Today the reviewer is a local path
   dependency. A repo-local action is much simpler; a publishable one needs the package on a
   registry or vendored into the action.
5. **Blocking or advisory?** Nothing in the requirements says the job should fail the PR check.
   Labels and a comment alone are advisory; a non-zero exit turns the reviewer into a merge gate.
6. **Exact label strings** — see §6. Confirm `ai-cr:failed` / `ai-cr:passed` / `ai-cr:review`.
7. **`gh pr comment --edit-last` when no prior comment exists** — verify on the runner's `gh`
   version, or use the HTML-marker + REST approach which has no version dependency.
