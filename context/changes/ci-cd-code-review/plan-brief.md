# CI/CD Agentic Code Review — Plan Brief

> Full plan: `context/changes/ci-cd-code-review/plan.md`
> Research: `context/changes/ci-cd-code-review/research.md`

## What & Why

Wire the existing `packages/code-reviewer` agent into GitHub Actions so every pull request to
`master` gets an automated review: a PR comment grading six criteria (correctness, idiomaticity,
complexity, test coverage, documentation, security) 1-10, plus one of three labels
(`ai-cr:passed` / `ai-cr:failed` / `ai-cr:review`), retriable by re-adding the review label.

## Starting Point

`packages/code-reviewer` is a working, tested `ToolLoopAgent` reviewer (read-only tools,
realpath-confined workspace, typed failures) that today reviews one file or inline snippet at a time
and prints to a terminal. It has never been called from CI, has no diff-shaped input, and its output
schema doesn't match the six-criterion rubric. There is no `.github/` directory yet — this is
greenfield CI, built entirely on top of a package the `tool-loop-agent` change already hardened.

## Desired End State

Open a PR against `master`: a bot comment appears with the criteria grades and any findings, one
label lands on the PR reflecting the verdict, pushing a new commit updates that same comment instead
of adding a new one, and adding `ai-cr:review` back onto an already-reviewed PR fires a fresh run.
The check never blocks merging — it's advisory.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Grade → verdict rule | Floor rule: any grade ≤4, or Security ≤6 → fail | A hard floor stops one catastrophic criterion from being averaged away by five good scores | Plan |
| Blocking vs advisory | Advisory only, job always exits 0 | Requirements never ask for a merge gate, and tool-use non-determinism means an identical re-run could flip the verdict | Plan |
| Fork PRs | `pull_request`, same-repo only | Single-contributor repo today; `pull_request_target` demands real security work with no current external contributors to justify it | Plan / Research |
| Review granularity | One diff-level review per PR, not per file | Four of the six criteria are change-level properties a per-file loop literally cannot see | Plan / Research |
| Label strings | `ai-cr:passed` / `ai-cr:failed` / `ai-cr:review` | Normalizes the two typo'd variants in requirements.md into one consistent prefix used everywhere | Plan |
| Sticky comment | HTML-marker + REST find/patch | No `gh`-CLI-version dependency, unlike `--edit-last`'s unverified empty-PR behavior | Plan / Research |
| Action reusability | Repo-local only, not published | Matches change.md's framing as "first GitHub Actions workflow"; no cross-repo reuse requested | Plan |
| Budget | `maxSteps` 16→40, job `timeout-minutes: 20`, diff capped at 60,000 chars | Unblocks realistic multi-file diffs while bounding worst-case runner cost/time | Plan / Research |
| Verdict logic placement | Pure function in the package (`computeVerdict`), not bash | Typed and unit-testable with the same `MockLanguageModelV4` pattern the package already uses | Plan |

## Scope

**In scope:**
- Diff-shaped review target, six-criterion schema, verdict function, markdown renderer (package)
- CI entrypoint script turning `{title, description, diff}` into `{verdict, comment-path}`
- Repo-local composite action (install, diff acquisition, running the reviewer)
- Calling workflow (trigger, label bootstrap, sticky comment, label swap, retry-on-label)

**Out of scope:**
- Fork PR support, blocking/required checks, per-file review loops
- Publishing the action or the reviewer package for reuse outside this repo
- Business alignment / architectural fit criteria (parked in requirements.md)
- Configurable verdict threshold, or updating the terminal CLI's renderer for the new criteria block

## Architecture / Approach

Judgement lives in TypeScript (the package), side effects live in YAML (the workflow). The package
grows a `diff` target kind, a graded schema, and a pure verdict function — all unit-tested the same
way the reviewer already is. A thin CI entrypoint script bridges that to files and `GITHUB_OUTPUT`.
A composite action owns installation and diff acquisition and calls that entrypoint. The workflow
owns everything GitHub-specific: triggers, label bootstrap, posting/updating the sticky comment, and
applying the verdict's label — keeping the action reusable and the workflow itself short.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Reviewer Core | Diff target, criteria schema, `computeVerdict`, markdown renderer, stdout fix | Schema/prompt changes must stay compiler-guided (exhaustive switch) to avoid silent gaps |
| 2. CI Entrypoint | `{title, description, diff}` → `{verdict, comment-path}`, testable in isolation | Workspace root must be explicit — defaulting to `cwd` would confine the review to the reviewer's own source |
| 3. Composite Action | Install, diff acquisition + capping, runs the entrypoint, exposes outputs | No `secrets` context in composite actions — every credential must be an explicit `input` |
| 4. Workflow | Trigger/permissions/concurrency, label bootstrap, sticky comment, label swap, retry | Comment-spam and label-drift if the sticky-comment marker or label swap isn't atomic per run |

**Prerequisites:** An `OPENROUTER_API_KEY` repo secret must exist before Phase 4 can run end-to-end.
**Estimated effort:** ~4 sessions, one per phase — Phase 1 is the largest (schema + prompt + tests).

## Open Risks & Assumptions

- The 60,000-character diff cap and the floor-rule thresholds (≤4 / security ≤6) are reasoned
  defaults, not empirically tuned — expect to revisit both after the first few real PRs run through.
- Tool-use non-determinism (noted in research) means the same code can grade differently across
  re-runs; this is why blocking was rejected, but it also means an occasional inconsistent comment
  is expected behavior, not a bug.
- `gh pr view`/`gh pr diff` behavior for very large or binary-heavy diffs hasn't been tested against
  a real PR yet — Phase 3's manual verification is the first real check of this.

## Success Criteria (Summary)

- Every PR to `master` gets exactly one comment (updated in place across pushes) and exactly one
  `ai-cr:*` label reflecting the six-criterion review.
- Re-adding `ai-cr:review` to a PR reliably triggers a fresh review without an infinite retry loop.
- No workflow run ever exposes secrets to or runs code from a fork PR.
