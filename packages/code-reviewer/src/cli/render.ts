import type { CodeReview } from "../schemas/code-review.js";

/** Formats a review for the terminal. Returns the text; printing is the CLI's job. */
export function renderReview(review: CodeReview): string {
  const lines = ["", review.summary, ""];

  if (review.findings.length === 0) {
    lines.push("No findings.");
    return lines.join("\n");
  }

  for (const finding of review.findings) {
    const location = finding.line === null ? "whole file" : `line ${finding.line}`;
    lines.push(
      `[${finding.severity.toUpperCase()}] ${location} - ${finding.title}`,
      `  why: ${finding.explanation}`,
      `  fix: ${finding.suggestion}`,
      "",
    );
  }

  return lines.join("\n");
}
