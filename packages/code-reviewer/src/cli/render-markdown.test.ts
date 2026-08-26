import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodeReview, Criteria } from "../schemas/code-review.js";
import { renderReviewMarkdown } from "./render-markdown.js";

function criteria(): Criteria {
  return {
    implementationCorrectness: { grade: 9, justification: "Solid." },
    idiomaticity: { grade: 8, justification: "Fits in." },
    complexity: { grade: 9, justification: "Flat." },
    testCoverage: { grade: 7, justification: "Mostly covered." },
    documentation: { grade: 8, justification: "Clear." },
    securityAndSafety: { grade: 10, justification: "Nothing to add." },
  };
}

describe("renderReviewMarkdown", () => {
  it("renders the criteria table", () => {
    const review: CodeReview = { summary: "Looks good.", criteria: criteria(), findings: [] };
    const markdown = renderReviewMarkdown(review);

    assert.ok(markdown.includes("## AI Code Review"));
    assert.ok(markdown.includes("| Implementation correctness | 9/10 | Solid. |"));
    assert.ok(markdown.includes("| Security and safety | 10/10 | Nothing to add. |"));
  });

  it("handles zero findings", () => {
    const review: CodeReview = { summary: "Clean.", criteria: criteria(), findings: [] };
    assert.ok(renderReviewMarkdown(review).includes("No findings."));
  });

  it("groups findings by file", () => {
    const review: CodeReview = {
      summary: "Two files touched.",
      criteria: criteria(),
      findings: [
        {
          file: "src/a.ts",
          line: 3,
          severity: "warning",
          title: "Unused import",
          explanation: "Dead weight.",
          suggestion: "Remove it.",
        },
        {
          file: "src/b.ts",
          line: null,
          severity: "error",
          title: "Missing null check",
          explanation: "Crashes on empty input.",
          suggestion: "Guard against null.",
        },
        {
          file: "src/a.ts",
          line: 10,
          severity: "info",
          title: "Could be simpler",
          explanation: "Extra indirection.",
          suggestion: "Inline it.",
        },
      ],
    };

    const markdown = renderReviewMarkdown(review);
    const aIndex = markdown.indexOf("### src/a.ts");
    const bIndex = markdown.indexOf("### src/b.ts");

    assert.ok(aIndex >= 0 && bIndex >= 0);
    assert.ok(markdown.includes("Unused import"));
    assert.ok(markdown.includes("Missing null check"));
    assert.ok(markdown.includes("Could be simpler"));
  });
});
