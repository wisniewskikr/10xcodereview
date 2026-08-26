/**
 * The CI entrypoint. Bridges diff-review inputs (read from CLI flags, since
 * GitHub Actions passes step inputs as command-line arguments or env vars,
 * not stdin) to the reviewer, then to a verdict and a rendered comment file -
 * mirroring `index.ts`'s split between argument parsing and the reviewer
 * call, but producing files/outputs instead of a terminal report.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { CodeReviewError, computeVerdict, createCodeReviewer, diffTarget, renderReviewMarkdown } from "./agent/index.js";
import { log } from "./utils/logger.js";

export type CiVerdict = "passed" | "failed" | "review";

export interface RunCiOptions {
  workspace: string;
  title: string;
  description?: string;
  diff: string;
  commentPath: string;
  maxSteps?: number;
  /** Test-only escape hatch: a ready-made model (e.g. `MockLanguageModelV4`) instead of OpenRouter. */
  model?: string | LanguageModel;
}

export interface RunCiResult {
  verdict: CiVerdict;
  commentPath: string;
}

function renderErrorMarkdown(error: CodeReviewError): string {
  return [
    "## AI Code Review",
    "",
    "The review could not be completed automatically.",
    "",
    `**Reason**: ${error.reason}`,
    "",
    error.message,
  ].join("\n");
}

function asCodeReviewError(error: unknown): CodeReviewError {
  if (CodeReviewError.isInstance(error)) {
    return error;
  }
  return new CodeReviewError({
    reason: "provider-error",
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

/**
 * Never throws - a review that could not conclude still produces a "review"
 * verdict and a comment, matching the advisory decision: the job should
 * never fail just because the model couldn't finish.
 */
export async function runCi(options: RunCiOptions): Promise<RunCiResult> {
  const target = diffTarget(options.title, options.diff, options.description);

  try {
    const review = await createCodeReviewer({
      workspaceRoot: options.workspace,
      maxSteps: options.maxSteps,
      model: options.model,
    }).review(target);

    const verdict = computeVerdict(review.criteria);
    writeFileSync(options.commentPath, renderReviewMarkdown(review), "utf8");
    return { verdict, commentPath: options.commentPath };
  } catch (error) {
    writeFileSync(options.commentPath, renderErrorMarkdown(asCodeReviewError(error)), "utf8");
    return { verdict: "review", commentPath: options.commentPath };
  }
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const value = argv[i + 1];
      if (value !== undefined) {
        args.set(arg.slice(2), value);
        i++;
      }
    }
  }
  return args;
}

/** A value can come in directly, or from a file - the composite action always uses the file form. */
function readFlag(args: Map<string, string>, flag: string, fileFlag: string): string | undefined {
  const direct = args.get(flag);
  if (direct !== undefined) {
    return direct;
  }
  const filePath = args.get(fileFlag);
  return filePath === undefined ? undefined : readFileSync(filePath, "utf8").trim();
}

function requireFlag(value: string | undefined, usage: string): string {
  if (value === undefined) {
    throw new Error(`Missing required ${usage}.`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const workspace = requireFlag(args.get("workspace"), "--workspace <path>");
  const title = requireFlag(readFlag(args, "title", "title-file"), "--title <text> or --title-file <path>");
  const description = readFlag(args, "description", "description-file");
  const diff = requireFlag(readFlag(args, "diff", "diff-file"), "--diff <text> or --diff-file <path>");
  const commentPath = requireFlag(args.get("comment-path"), "--comment-path <path>");
  const maxStepsRaw = args.get("max-steps");
  const maxSteps = maxStepsRaw === undefined ? undefined : Number(maxStepsRaw);

  const result = await runCi({ workspace, title, description, diff, commentPath, maxSteps });

  const outputPath = requireFlag(
    args.get("output") ?? process.env.GITHUB_OUTPUT,
    "GITHUB_OUTPUT env var (or --output <path> for local runs)",
  );
  appendFileSync(outputPath, `verdict=${result.verdict}\n`, "utf8");
  appendFileSync(outputPath, `comment-path=${result.commentPath}\n`, "utf8");

  process.exitCode = 0;
}

// Guarded so importing `runCi` for tests doesn't also run the CLI as a side effect.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
