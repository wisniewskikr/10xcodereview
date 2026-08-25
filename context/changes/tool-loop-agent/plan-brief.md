# Code Review ToolLoopAgent — Plan Brief

> Full plan: `context/changes/tool-loop-agent/plan.md`

## What & Why

Rebuild `packages/code-reviewer` as a modular code review agent on the AI SDK's `ToolLoopAgent`. Today the reviewer is a single `generateText` call that sees only the bytes handed to it — it cannot follow an import or check a caller before flagging a contract. Giving it read-and-search tools makes the loop earn its keep, and reorganising the package around a reusable factory means the prompt evals coming later can import the reviewer and sweep variants instead of editing source between runs.

## Starting Point

`packages/code-reviewer` is ~200 lines across 8 files, already partly modular (prompts and a `services/` layer exist) but architecturally single-shot. Schemas sit inline in the transport code (`src/services/code-review.ts:8-19`), config is frozen at import time (`src/utils/config.ts:29`) so two models can't coexist in one process, and `src/index.ts:44` runs `main()` at module scope so the entry point can never double as a library surface. A live `OPENROUTER_API_KEY` sits in `packages/code-reviewer/.env`, inside the tree the new tools will read.

## Desired End State

`createCodeReviewer(...)` is importable from a stable `agent/` barrel. With no arguments it's the CLI's reviewer; with overrides it's a variant on a different model, temperature, or named prompt. It takes a file path or an inline snippet, and the agent behind it can read, list, and search — but only under the workspace root it was built with. Every run traces its steps to the log; every failure raises a typed `CodeReviewError` instead of looking like a clean review.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Tool surface | `readFile`, `listDirectory`, `search` | Search is what lets the agent find callers and confirm a contract — without it the loop mostly re-reads what you already gave it. |
| Input contract | Path **or** inline code, one union | Real reviews get filesystem access for the tools to explore; inline strings keep the zero-setup `npm start` sample and string-based eval fixtures working. |
| Parameterisation | Factory with overrides, defaults from `config.json` | An eval builds several reviewers in one process; the config singleton can't vary within a run. |
| Call-options mechanism | **Not** using `callOptionsSchema`/`prepareCall` | `generate()` demands a `prompt` regardless, so routing the target through call options would force a dummy prompt — and model/variant are construction-time concerns anyway. |
| Filesystem safety | Workspace-root confinement, realpath-checked | One testable choke point stops the agent reading `.env` into the prompt and the log; the root binds by closure so no caller can forget it. |
| Export surface | Dedicated `src/agent/index.ts` barrel + `exports` map | Evals import one stable API with no CLI side effects; internals stay free to move. |
| Prompts | Keyed record of named variants + builder | A prompt eval becomes a loop over keys, with variants in version control where diffs are reviewable. |
| Tracing | Lifecycle callbacks into the existing logger | Makes the loop debuggable and gives a future eval behaviour to score, not just final JSON. |
| Failure semantics | Throw a typed `CodeReviewError` | A failed run must never be scored as "no findings". |

## Scope

**In scope:** schemas and prompt-variant modules; workspace path guard with unit tests; three read-only tools; the `ToolLoopAgent` factory and reviewer; typed errors; lifecycle tracing; CLI rewrite; public barrel and `exports` map; Readme update; three new `config.json` limits.

**Out of scope:** the eval environment itself (runner, datasets, scorers, CI); git/diff review; streaming and any UI; write/edit/shell tools, harnesses, sandboxes; multi-file review; tool approvals; provider changes; logger rewrite.

## Architecture / Approach

```
CLI (index.ts)  ─┐
eval harness ────┴─> agent/index.ts (barrel)
                        └─> createCodeReviewer(options)
                              ├─ prompts/    variant record + prompt builder
                              ├─ schemas/    codeReviewSchema -> Output.object
                              ├─ tools/      createFileTools(workspace)
                              │                └─ workspace.ts  ← the only path authority
                              ├─ services/   createReviewModel(modelId)
                              └─ agent/      tracing.ts, errors.ts
```

Everything an eval would vary is a constructor argument. The workspace root is captured by closure when the tools are built, so there is no code path that produces an unguarded tool, and guard rejections are thrown — the SDK turns them into `tool-error` parts the model reads and routes around.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Extract the pure modules | Schemas and prompt variants as standalone files; `createReviewModel(modelId)` | Prompt builder must produce genuinely different messages for path vs inline targets, or the agent never calls a tool |
| 2. Workspace guard + tools | Path confinement (realpath, size cap) and three read-only tools, with unit tests | The security boundary — a gap here reads the live API key into a prompt and a log file |
| 3. The agent | `createCodeReviewAgent` / `createCodeReviewer` on `ToolLoopAgent`; typed errors; tracing | Step budget must leave room for the structured-output step, which counts as its own |
| 4. CLI, surface, docs | Rewired CLI, `agent/` barrel + `exports` map, updated Readme | Barrel must stay side-effect-free or importing it fires credential loading |

**Prerequisites:** none beyond what's installed — `ai@7.0.79` is current, and the tests use Node's built-in runner plus `ai/test`, so no new dependencies.
**Estimated effort:** ~2–3 sessions across 4 phases; Phase 2 is the largest.

## Open Risks & Assumptions

- **Cost and latency rise materially.** A run with two reads and a search is roughly four model calls instead of one. `maxSteps` / `maxFileBytes` / `maxSearchResults` bound it, but the right values only become clear after real runs.
- **Tool use makes runs less deterministic**, which will make eval scoring noisier than the current single-shot call. That's the cost of the capability, worth knowing before the eval work starts.
- **Unit tests are included** (`node:test`, zero new dependencies) even though the eval environment is out of scope — the path guard is a security boundary and shouldn't ship untested. Cuttable if you'd rather keep this change to zero test infrastructure.
- **Workspace root defaults to `process.cwd()`.** Running the CLI from the repo root therefore puts the whole repo in scope, including other packages. Assumed acceptable; narrow the default if not.
- **Whether the model actually uses the tools is unverified** until a real run in Phase 3. If it reviews from the prompt alone and never calls a tool, the prompt variants need sharper tool-usage instructions.

## Success Criteria (Summary)

- `npm start -- <file>` produces a review, and the log shows the agent reading or searching before it answers.
- A second reviewer on a different model can be constructed and run in the same process — the shape a prompt eval needs.
- A tool asked for `.env` is refused, and no file contents ever reach `logs/*.log`.
