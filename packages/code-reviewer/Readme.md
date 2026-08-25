# Code Reviewer

An AI that reads your code and tells you what is broken.

Think of it as a very patient colleague who never gets tired of reading files.

## What it does

| Step | What happens |
| --- | --- |
| 1 | You give it a file |
| 2 | It sends the file to an AI model through OpenRouter |
| 3 | The AI answers in a fixed shape (checked by Zod) |
| 4 | You get a summary plus a list of findings |

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
npm start -- src/index.ts

# same, but restarts whenever you edit the code
npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Runs the app straight from TypeScript (via `tsx`) |
| `npm run dev` | Same, and restarts on every save |
| `npm run build` | Compiles TypeScript into `dist/` |
| `npm run typecheck` | Checks types without writing files |

## Settings

Two files, two jobs. Like a wallet and a notebook: the wallet holds the secret, the notebook holds the notes.

| File | Holds | Commit it? |
| --- | --- | --- |
| `.env` | Your API key | Never |
| `config.json` | Model name, temperature, token limit, timeout, log folder | Yes |

Change the model by editing one line in `config.json`:

```json
{ "model": "anthropic/claude-sonnet-5" }
```

Any model id from [openrouter.ai/models](https://openrouter.ai/models) works.

## Changing what the AI is asked

All the wording lives in `src/prompts/code-review.ts`. Edit the text there — you do not need to touch any other file.

## Logs

Every run writes to `logs/code-reviewer-YYYY-MM-DD.log`:

```
[2026-08-25 18:07:19] [INFO] Reviewing sample.ts with anthropic/claude-sonnet-5
[2026-08-25 18:07:27] [INFO] Review done: 2 finding(s), 780 input + 454 output tokens
```

Levels are `INFO`, `WARN`, and `ERROR`.

## Project structure

```
packages/code-reviewer/
├── src/
│   ├── index.ts               # entry point - start reading here
│   ├── prompts/
│   │   └── code-review.ts     # what the AI is asked
│   ├── services/
│   │   ├── model.ts           # OpenRouter connection
│   │   └── code-review.ts     # the review call + result shape
│   └── utils/
│       ├── config.ts          # reads and validates config.json
│       ├── env.ts             # reads .env
│       ├── logger.ts          # writes logs
│       └── paths.ts           # finds the project root
├── logs/                      # log files land here
├── config.json                # all settings
├── .env.example               # template for your key
└── tsconfig.json              # strict TypeScript setup
```

## Built with

| Package | Why |
| --- | --- |
| [`ai`](https://ai-sdk.dev/docs) v7 | Talks to the model |
| [`@openrouter/ai-sdk-provider`](https://openrouter.ai/docs) v3 | Plugs OpenRouter into the AI SDK |
| [`zod`](https://zod.dev) v4 | Guarantees the AI answers in the right shape |
| [`tsx`](https://tsx.is) | Runs TypeScript without a build step |
