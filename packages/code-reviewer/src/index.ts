import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { reviewCode, type CodeReview } from "./services/code-review.js";
import { log } from "./utils/logger.js";

/** A tiny, deliberately buggy snippet so `npm start` works with no arguments. */
const sampleCode = `export function averageOf(numbers: number[]): number {
  let total = 0;
  for (let i = 0; i <= numbers.length; i++) {
    total += numbers[i];
  }
  return total / numbers.length;
}`;

function readInput(filePath: string | undefined): { fileName: string; code: string } {
  if (filePath === undefined) {
    return { fileName: "sample.ts", code: sampleCode };
  }
  return { fileName: basename(filePath), code: readFileSync(filePath, "utf8") };
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
  const input = readInput(process.argv[2]);
  const review = await reviewCode(input);
  printReview(review);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
