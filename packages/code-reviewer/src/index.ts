import { createCodeReviewer, fileTarget, inlineTarget } from "./agent/code-review-agent.js";
import { CodeReviewError } from "./agent/errors.js";
import type { CodeReviewTarget } from "./prompts/code-review.js";
import type { CodeReview } from "./schemas/code-review.js";
import { log } from "./utils/logger.js";

/** A tiny, deliberately buggy snippet so `npm start` works with no arguments. */
const sampleCode = `export function averageOf(numbers: number[]): number {
  let total = 0;
  for (let i = 0; i <= numbers.length; i++) {
    total += numbers[i];
  }
  return total / numbers.length;
}`;

function readTarget(filePath: string | undefined): CodeReviewTarget {
  return filePath === undefined ? inlineTarget("sample.ts", sampleCode) : fileTarget(filePath);
}

function printReview(review: CodeReview): void {
  console.log(`\n${review.summary}\n`);

  if (review.findings.length === 0) {
    console.log("No findings.");
    return;
  }

  for (const finding of review.findings) {
    const location = finding.line === null ? "whole file" : `line ${finding.line}`;
    console.log(`[${finding.severity.toUpperCase()}] ${location} - ${finding.title}`);
    console.log(`  why: ${finding.explanation}`);
    console.log(`  fix: ${finding.suggestion}\n`);
  }
}

async function main(): Promise<void> {
  const review = await createCodeReviewer().review(readTarget(process.argv[2]));
  printReview(review);
}

main().catch((error: unknown) => {
  if (CodeReviewError.isInstance(error)) {
    log.error(`${error.reason}: ${error.message}`);
  } else {
    log.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
