# Code Reviewer

An AI that reads your code and tells you what is broken.

Think of it as a very patient colleague who never gets tired of reading files — and who, unlike a colleague, is happy to go look things up before answering.

## What it does

Older versions saw only the file you handed over. This one can go and look around first.

| Step | What happens |
| --- | --- |
| 1 | You give it a file |
| 2 | The AI reads that file with a tool |
| 3 | If it needs more, it reads an import, lists a folder, or searches for a caller |
| 4 | It repeats step 3 until it has enough |
| 5 | It answers in a fixed shape (checked by Zod) |
| 6 | You get a summary plus a list of findings |

The AI can **only read**. It cannot write, edit, delete, or run anything.

## Where it may look

The reviewer gets one folder, called the **workspace root**. By default that is the folder you ran it from.

Like a library card: it opens any book in **this** library, and no book anywhere else.

| Asked for | Answer |
| --- | --- |
| A file in the workspace | Reads it |
| `../../secrets.txt` | Refused — outside the workspace |
| A link pointing outside | Refused — it checks where links really go |
| `.env`, even inside the workspace | Refused — it holds your key |
| Anything in `node_modules`, `.git`, `dist` | Refused — not your code |
| A huge file | Reads the first part and says so |

## Requirements

| Thing | Version |
| --- | --- |
| Node.js | 22 or newer |
| npm | 10 or newer |
| OpenRouter API key | free to create at [openrouter.ai/keys](https://openrouter.ai/keys) |

## Installation

```bash
npm install
cp .env.example .env
```

Then open `.env` and paste your key:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

## Running

```bash
# review the built-in sample (a small buggy function)
npm start

# review a real file
npm start -- src/tools/search.ts

# same, but restarts whenever you edit the code
npm run dev
```

A bad path stops before it costs you anything:

```bash
npm start -- does/not/exist.ts   # says so, exits 1, no AI call
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Runs the app straight from TypeScript (via `tsx`) |
| `npm run dev` | Same, and restarts on every save |
| `npm test` | Runs the unit tests |
| `npm run build` | Compiles TypeScript into `dist/` |
| `npm run typecheck` | Checks types without writing files |

## Using it from your own code

The command line is just one caller. You can build a reviewer yourself:

```ts
import { createCodeReviewer } from "@10xcodereview/code-reviewer";

const reviewer = createCodeReviewer();

// a file, which the AI reads with its own tools
const review = await reviewer.review({ kind: "file", path: "src/index.ts" });

// or a snippet you already hold in a string
const other = await reviewer.review({
  kind: "inline",
  fileName: "sample.ts",
  code: "const x = 1;",
});

console.log(review.summary, review.findings.length);
```

Every setting can be overridden, so you can build several reviewers side by side and compare them:

```ts
const strict = createCodeReviewer({
  model: "anthropic/claude-sonnet-5",
  promptVariant: "evidence-first",
  workspaceRoot: "/path/to/project",
  temperature: 0,
  maxSteps: 16,
});
```

Two reviewers in one program never get in each other's way — handy for trying prompts against each other.

Import from the package root. That door opens nothing on its own: no key is read and no model is built until you call `createCodeReviewer`.

### When it goes wrong

A failed review **throws**. It never comes back as an empty review pretending all is well.

```ts
import { CodeReviewError } from "@10xcodereview/code-reviewer";

try {
  await reviewer.review({ kind: "file", path: "src/index.ts" });
} catch (error) {
  if (CodeReviewError.isInstance(error)) {
    console.error(error.reason); // why it failed
  }
}
```

| `reason` | Meaning |
| --- | --- |
| `step-budget-exhausted` | It ran out of turns before answering. Raise `maxSteps`. |
| `invalid-output` | It answered, but not in the shape Zod wants. |
| `provider-error` | The model, the network, or the request failed. |

## Settings

Two files, two jobs. Like a wallet and a notebook: the wallet holds the secret, the notebook holds the notes.

| File | Holds | Commit it? |
| --- | --- | --- |
| `.env` | Your API key | Never |
| `config.json` | Everything below | Yes |

| Key | What it does |
| --- | --- |
| `model` | Which AI to ask |
| `temperature` | How much it improvises (0 = not at all) |
| `maxOutputTokens` | Longest answer it may write |
| `requestTimeoutMs` | How long to wait before giving up |
| `maxRetries` | Retries after a failed request |
| `maxSteps` | Turns in the loop, **including** the one that writes the answer |
| `maxFileBytes` | Most it reads from one file |
| `maxSearchResults` | Most matches one search returns |
| `logDirectory` | Where logs go |
| `appName` | Name used in log file names |

Change the model by editing one line:

```json
{ "model": "anthropic/claude-sonnet-5" }
```

Any model id from [openrouter.ai/models](https://openrouter.ai/models) works.

> **About `maxSteps`.** Writing the final answer costs a turn of its own, so `16` allows 15 turns of looking around. Set it too low and the reviewer runs out of turns mid-thought and fails instead of answering.

## Changing what the AI is asked

All the wording lives in `src/prompts/code-review.ts`. Edit the text there — you do not need to touch any other file.

It now holds a small menu of named styles instead of one fixed text:

| Variant | Its style |
| --- | --- |
| `default` | Report every real problem you can see |
| `evidence-first` | Check each suspicion with the tools first, and stay quiet about the rest |

Pick one with `createCodeReviewer({ promptVariant: "evidence-first" })`. Add a key to the menu and it is available at once — no other file changes.

## Logs

Every run writes to `logs/code-reviewer-YYYY-MM-DD.log`, one line per thing that happened:

```
[2026-08-25 20:25:01] [INFO] [call-WyEv] review start: model=anthropic/claude-sonnet-5 prompt=default workspace=...
[2026-08-25 20:25:07] [INFO] [call-WyEv] tool readFile path="src/agent/code-review-agent.ts" -> ok in 2ms
[2026-08-25 20:25:07] [INFO] [call-WyEv] step 0 end: tool-calls, called readFile, 1928 in + 70 out tokens
[2026-08-25 20:25:23] [INFO] [call-WyEv] tool listDirectory path="node_modules/ai/dist" -> rejected in 1ms
[2026-08-25 20:26:36] [INFO] [call-WyEv] review end: stop after 11 step(s), 158818 in + 5132 out tokens
```

Levels are `INFO`, `WARN`, and `ERROR`. The `[call-...]` tag lets you follow one review when two run at once.

The log records **which file was asked for, never what was in it**. That keeps your code out of your log folder.

## Project structure

```
packages/code-reviewer/
├── src/
│   ├── agent/
│   │   ├── index.ts               # the public door - import from here
│   │   ├── code-review-agent.ts   # builds the reviewer
│   │   ├── errors.ts              # CodeReviewError
│   │   └── tracing.ts             # turns the loop into log lines
│   ├── cli/
│   │   └── render.ts              # formats a review for the screen
│   ├── index.ts                   # the command line - start reading here
│   ├── prompts/
│   │   └── code-review.ts         # what the AI is asked
│   ├── schemas/
│   │   └── code-review.ts         # the shape of an answer
│   ├── services/
│   │   └── model.ts               # OpenRouter connection
│   ├── tools/
│   │   ├── index.ts               # hands the tools their workspace
│   │   ├── workspace.ts           # the fence - every path goes through it
│   │   ├── read-file.ts           # tool: read a file
│   │   ├── list-directory.ts      # tool: list a folder
│   │   └── search.ts              # tool: find text
│   └── utils/
│       ├── config.ts              # reads and validates config.json
│       ├── env.ts                 # reads .env
│       ├── logger.ts              # writes logs
│       └── paths.ts               # finds the project root
├── logs/                          # log files land here
├── package.json                   # scripts and the public entry point
├── config.json                    # all settings
├── .env.example                   # template for your key
├── tsconfig.json                  # strict TypeScript setup
└── tsconfig.test.json             # same, but also checks the tests
```

Tests sit next to what they test, named `*.test.ts`. They are left out of `dist/`.

## Built with

| Package | Why |
| --- | --- |
| [`ai`](https://ai-sdk.dev/docs) v7 | Talks to the model and runs the tool loop (`ToolLoopAgent`) |
| [`@openrouter/ai-sdk-provider`](https://openrouter.ai/docs) v3 | Plugs OpenRouter into the AI SDK |
| [`zod`](https://zod.dev) v4 | Guarantees the AI answers in the right shape |
| [`tsx`](https://tsx.is) | Runs TypeScript without a build step |

No test framework needed: the tests use Node's own runner.
