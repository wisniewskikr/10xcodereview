# Code Review ToolLoopAgent Implementation Plan

## Overview

Rebuild `packages/code-reviewer` as a modular, reusable code review agent on the AI SDK's `ToolLoopAgent`. The reviewer gains read-and-search tools bounded to a workspace root, structured output and prompts move into dedicated modules, and the whole thing is exposed through one public barrel so a future eval harness can import and sweep it without touching internals or spawning a process per variant.

## Current State Analysis

The package is small (8 files, ~200 lines) and already partly modular — prompts live in `src/prompts/code-review.ts` and there is a `services/` layer — but the architecture is single-shot, not agentic:

- **No agent, no tools.** `reviewCode` (`src/services/code-review.ts:24`) is one `generateText` call with `Output.object`. The model sees exactly the bytes handed to it and can never look at an import, a caller, or a sibling type.
- **Schemas are co-located with the call.** `findingSchema` and `codeReviewSchema` sit at `src/services/code-review.ts:8-19`, inseparable from the transport code that uses them.
- **Config is frozen at import time.** `export const config = readConfig()` (`src/utils/config.ts:29`) runs on first import and is read by `model.ts` and `logger.ts`. `createReviewModel()` (`src/services/model.ts:7`) takes no arguments and reads `config.model` directly, so a single process cannot hold two agents on different models.
- **The entry point runs on import.** `src/index.ts:44` calls `main()` at module scope, so the file can never double as a library surface.
- **Prompts are a single flat string.** `codeReviewInstructions` (`src/prompts/code-review.ts:5`) is one joined constant — comparing two instruction variants means editing the file.
- **Strict module conventions apply.** NodeNext ESM with explicit `.js` import specifiers, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `strict`, `declaration: true` (`tsconfig.json`).
- **A live secret sits inside the package.** `packages/code-reviewer/.env` holds a real `OPENROUTER_API_KEY`. Any filesystem tool added here without a guard can read it into the prompt and into `logs/*.log`.

## Desired End State

`packages/code-reviewer` exposes a `createCodeReviewer(...)` factory from a stable `agent/` barrel. Calling it with no arguments yields the CLI's default reviewer; calling it with overrides yields a variant on a different model, temperature, or named prompt. The returned reviewer accepts either a workspace-relative file path or an inline code string, and the underlying `ToolLoopAgent` may read files, list directories, and search text — but only beneath the workspace root it was constructed with. Every run emits a step-by-step trace to the existing logger, and every failure — exhausted step budget, schema-validation miss, provider error — surfaces as a typed `CodeReviewError` rather than an empty-looking review.

Verify by: `npm run typecheck` and `npm test` pass; `npm start` reviews the built-in sample; `npm start -- src/services/model.ts` produces a review whose log shows the agent calling at least one tool; a scratch script constructing two reviewers on different models in one process typechecks and runs.

### Key Discoveries:

- `runtimeContext` is **not** passed to tool `execute` — only per-tool `context` derived from `toolsContext` is (`node_modules/ai/docs/03-ai-sdk-core/17-runtime-and-tool-context.mdx:203-213`). Since the workspace root shares the agent's lifetime, binding it by closure in a tool factory is both simpler and safer than `toolsContext`: the guard lives in one module and no caller can omit it.
- Errors thrown inside a tool's `execute` become `tool-error` content parts fed back to the model for a further step, rather than aborting the run (`node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx:1140`). Tools therefore need no result union — a guard rejection is a `throw`.
- Producing the structured output **counts as its own step** (`node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx:312-314`). `stopWhen` must budget tool steps plus one.
- Lifecycle callbacks (`onStart`, `onStepStart`, `onToolExecutionStart/End`, `onStepEnd`, `onEnd`) are constructor-level settings on `ToolLoopAgent` (`node_modules/ai/src/agent/tool-loop-agent.ts:39-63`), so tracing is wired once at construction and needs no per-call plumbing.
- `generate()` requires `prompt` or `messages` whether or not `callOptionsSchema` is set (`node_modules/ai/src/agent/agent.ts:36-64`). This is why the plan puts variant selection on the factory instead of on call options — see "Implementation Approach".
- `MockLanguageModelV4` ships in `ai/test` (`node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx:33`) and Node 25 has a built-in test runner, so the pure modules get real tests with **zero new dependencies**.
- Installed `ai` is 7.0.79, which is also the current published version — no migration needed.

## What We're NOT Doing

- **No eval environment.** No eval runner, dataset format, scorers, CI wiring, or golden fixtures. This change only makes the reviewer *importable and parameterisable* so that work can start cleanly later.
- **No git integration.** Reviewing diffs or changed hunks is out of scope; input is a file path or an inline string.
- **No streaming.** `agent.stream()` and any TUI/UI surface are out of scope; the reviewer is `generate()`-only.
- **No write, edit, or shell tools.** The agent is strictly read-only. No `@ai-sdk/harness`, no sandbox.
- **No multi-file or whole-repo review.** One review target per call; the agent may *read* other files for context but reports on the target.
- **No tool-approval flow.** All tools auto-execute; `toolApproval` stays unconfigured.
- **No provider change.** OpenRouter via `@openrouter/ai-sdk-provider` stays as-is.
- **No logger rewrite.** The existing `log` helper gains callers, not features.

## Implementation Approach

Four phases, each ending at a state that typechecks and runs.

The sequencing is deliberate: the two phases that produce **pure, testable modules** (schemas/prompts, then the workspace guard and tools) land before the phase that **integrates them into an agent**. That keeps the security-critical path guard reviewable in isolation, and means the risky integration step has nothing left to invent.

**On the shape of the public surface.** The reviewer is parameterised at *construction*, not per call. `createCodeReviewer({ model, temperature, promptVariant, workspaceRoot, ... })` returns `{ agent, review(target) }`. This is a deliberate choice over the SDK's `callOptionsSchema` + `prepareCall` mechanism: `generate()` demands a `prompt` or `messages` argument regardless of call options, so routing the review target through options would force every caller to pass a dummy prompt that `prepareCall` then discards. Construction-time parameterisation also matches how a prompt eval actually works — build N reviewers, push identical fixtures through each — and keeps a reviewer instance immutable and safe to reuse across a fixture set.

**On the workspace boundary.** One module owns path resolution and every tool goes through it. The root is captured by closure when tools are built, so there is no code path that constructs an unguarded tool. Rejections are thrown, which the SDK converts into `tool-error` parts the model can read and route around.

## Critical Implementation Details

**Step budget must include the output step.** The structured object is generated in its own step after the last tool call. A budget of `isStepCount(n)` therefore permits at most `n-1` tool-calling steps. Size it from `config.maxSteps` and default it high enough that a couple of reads plus a search still leave room for the answer.

**Guard against symlink escapes, in the right order.** Resolving a path against the root and prefix-checking the string is not sufficient — a symlink inside the workspace can point outside it. The containment check must run against the *real* path of the resolved target, and the root itself must be realpath'd once at construction so the two sides are comparable. A prefix comparison also needs the trailing separator, or `/work` wrongly contains `/workspace`.

**Tool rejection messages are read by the model, not just by humans.** When the guard refuses a path, the thrown message becomes a `tool-error` part in the conversation. Say what the agent *may* access (the workspace root, the target file) rather than emitting a bare "access denied" the model can only retry against.

**Test files must be excluded from the build.** `tsconfig.json` has `include: ["src"]` with `declaration: true` and `outDir: dist`. Adding `src/**/*.test.ts` without a matching `exclude` puts compiled tests and their `.d.ts` files into the published `dist/`.

**Module syntax is not negotiable here.** `verbatimModuleSyntax` means type-only imports must use `import type`, and NodeNext resolution means every relative import carries a `.js` extension even though the source is `.ts`. Both are already the convention in every existing file.

---

## Phase 1: Extract the Pure Modules

### Overview

Move the output schemas and the prompt text into standalone modules, and make the model factory accept a model id. Behaviour is unchanged and the existing `reviewCode` path keeps working — this phase only breaks the coupling that later phases depend on.

### Changes Required:

#### 1. Output schemas

**File**: `packages/code-reviewer/src/schemas/code-review.ts` (new)

**Intent**: Give the structured output shape a home of its own, so the agent, the CLI renderer, and a future eval scorer can all import it without dragging in the AI SDK or the transport code.

**Contract**: Exports `findingSchema`, `codeReviewSchema`, and the inferred `Finding` and `CodeReview` types, moved verbatim from `src/services/code-review.ts:8-22`. The `.describe()` annotations are load-bearing prompt surface — carry them across unchanged. This module imports `zod` only.

#### 2. Prompt variants

**File**: `packages/code-reviewer/src/prompts/code-review.ts` (rewrite)

**Intent**: Turn the single instruction constant into a keyed set of named variants so a prompt eval can iterate over keys, and keep the user-message builder alongside it.

**Contract**: Exports a record of instruction variants keyed by name, a `CodeReviewPromptVariant` type derived from that record's keys, a `defaultPromptVariant` constant, and `buildCodeReviewPrompt(target)`. Today's wording becomes the default variant; seed exactly one alternative so the variant mechanism is exercised rather than theoretical. `buildCodeReviewPrompt` accepts the review target union defined in Phase 3 — for now type it structurally as `{ fileName: string; code?: string; path?: string }` and tighten it when the target type lands.

The builder must produce a materially different message for the two input kinds: an inline target embeds the code in the prompt as today, while a path target names the file and tells the agent to read it with its tools. Getting this wrong is the difference between a working tool loop and an agent that never calls a tool.

#### 3. Injectable model factory

**File**: `packages/code-reviewer/src/services/model.ts`

**Intent**: Let callers choose the model instead of reading it from the config singleton, which is what allows several agent variants to coexist in one process.

**Contract**: `createReviewModel(modelId: string): LanguageModel`. The `loadEnvFile()` + `requireEnv` credential handling stays exactly where it is. Callers supply the id; `config.model` becomes the default the factory applies, not a value this function reaches for.

#### 4. Keep the existing path compiling

**File**: `packages/code-reviewer/src/services/code-review.ts`

**Intent**: Re-point the existing service at the extracted modules so the tree still builds and runs at the end of this phase. This file is deleted in Phase 3.

**Contract**: Import the schemas from `../schemas/code-review.js` and the default instruction variant from the rewritten prompts module; pass `config.model` to `createReviewModel`. Re-export `Finding`/`CodeReview` from here if `src/index.ts` still imports them, so the CLI is untouched this phase.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Build succeeds: `npm run build`
- No module still declares the review schemas outside `src/schemas/`: `grep -rn "z.object" src/ | grep -v "src/schemas\|src/utils/config"` returns nothing unexpected

#### Manual Verification:

- `npm start` still reviews the built-in sample and prints the same shape of output as before the change
- The alternative prompt variant reads as a genuinely different reviewing stance, not a paraphrase of the default

**Implementation Note**: After this phase and its automated verification, pause for confirmation that `npm start` behaves as before.

---

## Phase 2: Workspace Guard and File Tools

### Overview

Build the read-only tool surface and the path boundary that contains it. This is the security-critical phase: `packages/code-reviewer/.env` holds a live API key, and these tools are what could otherwise read it into a prompt. It lands with unit tests and without any agent wired up yet.

### Changes Required:

#### 1. Workspace boundary

**File**: `packages/code-reviewer/src/tools/workspace.ts` (new)

**Intent**: Own every path decision the tools make, in one testable place, so containment is a property of the module rather than a habit of each tool.

**Contract**: `createWorkspace(root: string, limits?: { maxFileBytes?: number }): Workspace`, where `Workspace` exposes the realpath'd `root`, a `resolve(inputPath: string): string` that returns an absolute path or throws when the target escapes the root, and a `readTextFile(inputPath: string): string` that additionally enforces the byte cap and rejects non-UTF-8/binary content.

Containment is checked against the resolved target's real path, and the root is realpath'd once at construction — see "Critical Implementation Details". Absolute inputs are accepted only if they land inside the root; relative inputs resolve against it. Rejection messages name the workspace root.

#### 2. Read-file tool

**File**: `packages/code-reviewer/src/tools/read-file.ts` (new)

**Intent**: Let the agent pull in a file it decides it needs — an import, a sibling type, the module under review.

**Contract**: A `tool()` whose `inputSchema` takes a workspace-relative path and an optional line range, executing through `workspace.readTextFile`. Return line-numbered text: the finding schema asks the model for line numbers, and a model counting newlines by hand gets them wrong. Truncation, when the cap bites, must be visible in the returned text so the model knows it saw a prefix.

#### 3. List-directory tool

**File**: `packages/code-reviewer/src/tools/list-directory.ts` (new)

**Intent**: Let the agent orient itself before guessing at paths.

**Contract**: A `tool()` taking a workspace-relative directory path, returning entry names with a file/directory marker, non-recursive. Skip `node_modules`, `.git`, and `dist` — they are noise that costs tokens and invites the agent to wander.

#### 4. Search tool

**File**: `packages/code-reviewer/src/tools/search.ts` (new)

**Intent**: Let the agent find callers and definitions across the workspace — the capability that makes a tool loop worth more than a single-shot review.

**Contract**: A `tool()` taking a query string, an optional file-glob filter, and an optional case-sensitivity flag; returns capped `{ path, line, text }` matches. Implement with a filesystem walk and in-process matching — **do not shell out to `grep` or `rg`**, which are not reliably present on Windows, where this package is developed. Every candidate path passes through the workspace guard, and the result count is capped from config so one broad query cannot blow the context window.

#### 5. Tool set factory

**File**: `packages/code-reviewer/src/tools/index.ts` (new)

**Intent**: Assemble the tools against one workspace so the agent module never sees an unbound tool.

**Contract**: `createFileTools(workspace: Workspace)` returning a tool set keyed `readFile`, `listDirectory`, `search`. The workspace is captured by closure. Export the tool-set type for the agent's generic parameter.

#### 6. Guard and search tests

**File**: `packages/code-reviewer/src/tools/workspace.test.ts`, `packages/code-reviewer/src/tools/search.test.ts` (new)

**Intent**: Prove the containment boundary holds, because an untested security boundary is how the key in `.env` ends up in a log file.

**Contract**: `node:test` + `node:assert/strict`, no new dependencies. Cover at minimum: a relative path inside the root resolves; `../` traversal is rejected; an absolute path outside the root is rejected; a symlink pointing outside the root is rejected; a file over the byte cap is truncated or rejected per the chosen semantics; search respects its result cap and never returns a path outside the root. Build symlink fixtures in a temp directory at test time and skip the symlink case gracefully where the platform forbids creating one unprivileged.

#### 7. Test wiring

**File**: `packages/code-reviewer/package.json`, `packages/code-reviewer/tsconfig.json`

**Intent**: Make the tests runnable without adding dependencies, and keep them out of the published build.

**Contract**: Add a `test` script running Node's built-in runner over `src/**/*.test.ts` with `tsx` as the loader. Add `"exclude": ["src/**/*.test.ts"]` to `tsconfig.json` — without it, `declaration: true` emits test types into `dist/`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Unit tests pass: `npm test`
- Traversal is rejected — the `../` and absolute-path cases in `workspace.test.ts` assert a throw
- Symlink escape is rejected (or the case skips with a clear message on unsupported platforms)
- `dist/` contains no test artifacts after `npm run build`: `ls dist/tools/ | grep test` returns nothing

#### Manual Verification:

- A scratch call to `readFile` with `../../.env` fails with a message that names the workspace root and does not leak file contents
- Search over the package returns plausible matches with correct line numbers
- `listDirectory` on the package root omits `node_modules`, `.git`, and `dist`

**Implementation Note**: Pause after this phase for confirmation that the guard rejects the `.env` path by hand, not only in tests.

---

## Phase 3: The Agent

### Overview

Wire schemas, prompts, and tools into a `ToolLoopAgent` behind a reusable factory, with a typed error contract and lifecycle tracing. Retires the single-shot service.

### Changes Required:

#### 1. Typed failure

**File**: `packages/code-reviewer/src/agent/errors.ts` (new)

**Intent**: Make a failed review impossible to mistake for a clean one — the difference between an eval row scored as "no findings" and one counted as a failure.

**Contract**: A `CodeReviewError extends Error` carrying `cause`, the reason (`step-budget-exhausted` | `invalid-output` | `provider-error`), and whatever `steps`/`usage` were observed. Include a static `isInstance`-style guard consistent with how the AI SDK's own errors are tested.

#### 2. Lifecycle tracing

**File**: `packages/code-reviewer/src/agent/tracing.ts` (new)

**Intent**: Turn the loop from a black box into a readable trace, and give a future eval something to score behaviour against rather than only the final JSON.

**Contract**: A function returning the `onStart` / `onStepStart` / `onToolExecutionEnd` / `onStepEnd` / `onEnd` callbacks bound to the existing `log` helper. Log step number, tool name, the *path or query* the tool received, execution duration, and per-step token usage.

**Log the shape of what the tool touched, never its contents.** A tool result is file text; writing it to `logs/*.log` recreates on disk exactly the exposure the workspace guard exists to prevent.

#### 3. The agent factory and reviewer

**File**: `packages/code-reviewer/src/agent/code-review-agent.ts` (new)

**Intent**: The heart of the change — one construction site for a reviewer, parameterised by everything an eval would want to vary.

**Contract**: Two exports.

`createCodeReviewAgent(options?)` builds the `ToolLoopAgent`: `model` from `createReviewModel(options.model ?? config.model)`, `instructions` from the selected prompt variant, `tools` from `createFileTools(createWorkspace(options.workspaceRoot ?? process.cwd()))`, `output: Output.object({ schema: codeReviewSchema })`, `stopWhen: isStepCount(options.maxSteps ?? config.maxSteps)`, plus `temperature`, `maxOutputTokens`, `maxRetries`, `timeout` layered over `config` defaults, and the tracing callbacks.

`createCodeReviewer(options?)` returns `{ agent, review(target) }`. `review` builds the user prompt via the prompts module, calls `agent.generate({ prompt })`, and returns the parsed `CodeReview` — translating any thrown SDK error, a missing/unparseable `output`, or a run that stopped on the step budget into a `CodeReviewError`.

The review target is the union agreed for this change: `{ kind: 'file'; path: string } | { kind: 'inline'; fileName: string; code: string }`. Export it as `CodeReviewTarget` and tighten `buildCodeReviewPrompt`'s parameter to it now.

Both option objects are exported as types — they are the eval harness's tuning surface, so every field an eval would sweep (model, temperature, prompt variant, step budget) must be reachable and optional.

#### 4. Retire the single-shot service

**File**: `packages/code-reviewer/src/services/code-review.ts` (delete)

**Intent**: Remove the parallel implementation so there is exactly one review path.

**Contract**: Delete the file. `src/services/model.ts` stays. Anything still importing `reviewCode` moves to `createCodeReviewer` in Phase 4 — if `src/index.ts` breaks at this point, that is expected and is fixed in the next phase.

#### 5. Config surface for the new knobs

**File**: `packages/code-reviewer/config.json`, `packages/code-reviewer/src/utils/config.ts`

**Intent**: Give the new agent-level limits the same file-backed, schema-validated defaults everything else already has.

**Contract**: Add `maxSteps`, `maxFileBytes`, and `maxSearchResults` to both the JSON and `configSchema`, as positive integers. Size `maxSteps` so a couple of reads plus a search still leave a step for the structured output.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Unit tests pass: `npm test`
- `src/services/code-review.ts` no longer exists and nothing imports it: `grep -rn "services/code-review" src/` returns nothing
- A `MockLanguageModelV4`-backed test asserts that malformed model output raises `CodeReviewError` rather than returning a review

#### Manual Verification:

- A real run against a file that imports another module shows at least one `readFile` or `search` tool call in the log
- The trace names tool inputs but contains no file contents
- Two reviewers on different models can be constructed and run in the same process without interfering

**Implementation Note**: Pause after this phase for confirmation that a real run's trace looks right before the CLI is rewired.

---

## Phase 4: CLI, Public Surface, and Docs

### Overview

Point the CLI at the new reviewer, publish the agent barrel as the package's importable API, and update the Readme so its structure section is not lying.

### Changes Required:

#### 1. Public barrel

**File**: `packages/code-reviewer/src/agent/index.ts` (new)

**Intent**: One import path for consumers — the future eval harness included — so internals stay free to move.

**Contract**: Re-export `createCodeReviewer`, `createCodeReviewAgent`, their option types, `CodeReviewTarget`, `CodeReviewError`, the schemas and `CodeReview`/`Finding` types, and the prompt-variant record with its key type. Export nothing else, and keep this module free of side effects — importing it must not read `.env`, construct a model, or touch the filesystem.

#### 2. Package exports map

**File**: `packages/code-reviewer/package.json`

**Intent**: Make the barrel the supported entry point and stop consumers reaching into `dist/` internals.

**Contract**: An `exports` map with the agent barrel as the package's public entry (types + import condition pointing at the built output), leaving the CLI reachable for `npm start`. Keep `main`/`types` consistent with it.

#### 3. CLI rewrite

**File**: `packages/code-reviewer/src/index.ts`, `packages/code-reviewer/src/cli/render.ts` (new)

**Intent**: Reduce the entry point to argument handling and process exit, with rendering as its own module, so nothing library-shaped lives behind a `main()` that runs on import.

**Contract**: `render.ts` exports the console formatting currently at `src/index.ts:22-36`, taking a `CodeReview`. `index.ts` parses `process.argv[2]` into a `CodeReviewTarget` — a path argument becomes `{ kind: 'file' }` with the workspace root defaulting to `process.cwd()`, no argument keeps the built-in buggy sample as `{ kind: 'inline' }` — then calls `createCodeReviewer().review(target)`, renders, and catches `CodeReviewError` to log the reason and set a non-zero exit code.

#### 4. Readme

**File**: `packages/code-reviewer/Readme.md`

**Intent**: The Readme documents a structure that this change replaces; leaving it stale makes the package harder to pick up than having no docs at all.

**Contract**: Update the project-structure tree, the "Changing what the AI is asked" section (now prompt variants, not one string), and the settings table (the new `maxSteps` / `maxFileBytes` / `maxSearchResults` keys). Add a short section showing how to import `createCodeReviewer` and run it with overrides — that is the surface the eval work will build on. Note the workspace-root boundary and that the agent is read-only.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Build succeeds: `npm run build`
- Unit tests pass: `npm test`
- Importing the barrel has no side effects: a script that imports it and exits runs cleanly with `OPENROUTER_API_KEY` unset
- The CLI exits non-zero on a nonexistent path: `npm start -- does/not/exist.ts; echo $?` reports non-zero

#### Manual Verification:

- `npm start` reviews the built-in sample and prints findings as before
- `npm start -- src/tools/search.ts` produces a review, and the log shows tool calls
- The Readme's structure tree matches the tree on disk
- A fresh reader can follow the Readme's import example without opening the source

**Implementation Note**: This is the last phase; confirm the CLI and the documented import example both work before considering the change done.

---

## Testing Strategy

### Unit Tests:

- **Workspace guard** — the containment boundary: relative resolution, `../` traversal, absolute paths outside the root, symlink escape, byte cap. This is the security-critical suite.
- **Search** — result cap honoured, line numbers correct, no path outside the root ever returned.
- **Prompt builder** — a path target and an inline target produce materially different messages; every variant key builds without throwing.
- **Error translation** — with `MockLanguageModelV4` from `ai/test`, malformed output raises `CodeReviewError` rather than returning a review.

### Integration Tests:

Not automated in this change — a real integration test means a paid model call, which belongs with the eval work that is explicitly out of scope. The manual steps below stand in for it.

### Manual Testing Steps:

1. `npm start` — the built-in sample is reviewed and findings print.
2. `npm start -- src/agent/code-review-agent.ts` — a real file is reviewed; the log shows at least one tool call.
3. Inspect `logs/code-reviewer-*.log` — steps and tool inputs appear; **no file contents do**.
4. `npm start -- ../../package.json` from inside the package — the guard rejects, or the file is read only if it genuinely sits under the workspace root; either way the behaviour matches the documented boundary.
5. In a scratch script, construct two reviewers with different `model` values and review the same target with both — both complete, and the logs show the two different model ids.

## Performance Considerations

The tool loop trades cost and latency for accuracy: a run that reads two files and runs a search is roughly four model calls instead of one. Three limits bound that — `maxSteps` caps the loop, `maxFileBytes` caps a single read, and `maxSearchResults` caps a query's return. All three live in `config.json`, so tightening them after seeing real token counts requires no code change. The search walk is in-process and unindexed; on a large repository the directory skips (`node_modules`, `.git`, `dist`) are what keep it viable.

## Migration Notes

Nothing persists, so there is no data migration. The breaking change is API-shaped: `reviewCode({ fileName, code })` disappears in Phase 3, replaced by `createCodeReviewer().review(target)`. The package is `private: true` with a single in-repo consumer (its own CLI), so no deprecation period is needed. `config.json` gains three keys — an existing config file without them fails `configSchema` validation at startup with a clear message, which is the intended behaviour rather than silent defaults.

## References

- AI SDK skill: `packages/code-reviewer/.claude/skills/ai-sdk/SKILL.md`
- `ToolLoopAgent` source: `node_modules/ai/src/agent/tool-loop-agent.ts:39`, settings at `node_modules/ai/src/agent/tool-loop-agent-settings.ts:286-303`
- Agent call parameters: `node_modules/ai/src/agent/agent.ts:36-64`
- Building agents guide: `node_modules/ai/docs/03-agents/02-building-agents.mdx`
- Structured output with tools: `node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx:279-315`
- Runtime and tool context: `node_modules/ai/docs/03-ai-sdk-core/17-runtime-and-tool-context.mdx:203-224`
- Tool error handling: `node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx:1134-1176`
- Testing helpers: `node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx`
- Code being replaced: `packages/code-reviewer/src/services/code-review.ts:8-47`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Extract the Pure Modules

#### Automated

- [x] 1.1 Type checking passes: `npm run typecheck` — 2b00df1
- [x] 1.2 Build succeeds: `npm run build` — 2b00df1
- [x] 1.3 No module declares review schemas outside `src/schemas/` — 2b00df1

#### Manual

- [x] 1.4 `npm start` reviews the built-in sample with unchanged output shape — 2b00df1
- [x] 1.5 The alternative prompt variant is a genuinely different reviewing stance — 2b00df1

### Phase 2: Workspace Guard and File Tools

#### Automated

- [x] 2.1 Type checking passes: `npm run typecheck` — f8c4be6
- [x] 2.2 Unit tests pass: `npm test` — f8c4be6
- [x] 2.3 Traversal (`../` and absolute-outside-root) is rejected — f8c4be6
- [x] 2.4 Symlink escape is rejected, or skips with a clear message — f8c4be6
- [x] 2.5 `dist/` contains no test artifacts after `npm run build` — f8c4be6

#### Manual

- [x] 2.6 `readFile` on `../../.env` fails naming the workspace root, leaking nothing — f8c4be6
- [x] 2.7 Search returns plausible matches with correct line numbers — f8c4be6
- [x] 2.8 `listDirectory` omits `node_modules`, `.git`, and `dist` — f8c4be6

### Phase 3: The Agent

#### Automated

- [x] 3.1 Type checking passes: `npm run typecheck` — f65a763
- [x] 3.2 Unit tests pass: `npm test` — f65a763
- [x] 3.3 `src/services/code-review.ts` is deleted and unreferenced — f65a763
- [x] 3.4 Mock-model test asserts malformed output raises `CodeReviewError` — f65a763

#### Manual

- [x] 3.5 A real run shows at least one tool call in the log — f65a763
- [x] 3.6 The trace names tool inputs but contains no file contents — f65a763
- [x] 3.7 Two reviewers on different models run in one process without interfering — f65a763

### Phase 4: CLI, Public Surface, and Docs

#### Automated

- [x] 4.1 Type checking passes: `npm run typecheck` — c698539
- [x] 4.2 Build succeeds: `npm run build` — c698539
- [x] 4.3 Unit tests pass: `npm test` — c698539
- [x] 4.4 Importing the barrel has no side effects with `OPENROUTER_API_KEY` unset — c698539
- [x] 4.5 CLI exits non-zero on a nonexistent path — c698539

#### Manual

- [x] 4.6 `npm start` reviews the built-in sample and prints findings — c698539
- [x] 4.7 `npm start -- <real file>` produces a review with tool calls in the log — c698539
- [x] 4.8 The Readme's structure tree matches the tree on disk — c698539
- [x] 4.9 The Readme's import example works as written — c698539
