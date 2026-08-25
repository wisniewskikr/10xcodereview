/**
 * The CLI. Argument handling, rendering, and an exit code - nothing else, so
 * everything library-shaped lives behind the side-effect-free agent/ barrel.
 */

import { CodeReviewError, createCodeReviewer, fileTarget, inlineTarget } from "./agent/index.js";
import type { CodeReviewTarget } from "./agent/index.js";
import { renderReview } from "./cli/render.js";
import { createWorkspace } from "./tools/workspace.js";
import { log } from "./utils/logger.js";

/** A tiny, deliberately buggy snippet so `npm start` works with no arguments. */
const sampleCode = `export function averageOf(numbers: number[]): number {
  let total = 0;
  for (let i = 0; i <= numbers.length; i++) {
    total += numbers[i];
  }
  return total / numbers.length;
}`;

function parseTarget(argument: string | undefined): CodeReviewTarget {
  if (argument === undefined) {
    return inlineTarget("sample.ts", sampleCode);
  }

  // Check the path against the same boundary the agent's tools enforce, so a
  // typo or an out-of-workspace path fails here instead of costing a model call
  // that could only report the miss back to us.
  createWorkspace(process.cwd()).readTextFile(argument);

  return fileTarget(argument);
}

async function main(): Promise<void> {
  const review = await createCodeReviewer().review(parseTarget(process.argv[2]));
  console.log(renderReview(review));
}

main().catch((error: unknown) => {
  if (CodeReviewError.isInstance(error)) {
    log.error(`${error.reason}: ${error.message}`);
  } else {
    log.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
