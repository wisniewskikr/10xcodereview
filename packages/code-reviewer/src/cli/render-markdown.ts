import type { CodeReview, Finding } from "../schemas/code-review.js";

const criterionLabels = {
  implementationCorrectness: "Implementation correctness",
  idiomaticity: "Idiomaticity",
  complexity: "Complexity",
  testCoverage: "Test / risk coverage",
  documentation: "Documentation",
  securityAndSafety: "Security and safety",
} as const;

function renderCriteriaTable(review: CodeReview): string[] {
  const lines = ["| Criterion | Grade | Notes |", "|---|---|---|"];

  for (const [key, label] of Object.entries(criterionLabels)) {
    const criterion = review.criteria[key as keyof typeof criterionLabels];
    lines.push(`| ${label} | ${criterion.grade}/10 | ${criterion.justification} |`);
  }

  return lines;
}

function renderFinding(finding: Finding): string[] {
  const location = finding.line === null ? "whole file" : `line ${finding.line}`;
  return [
    `- **[${finding.severity.toUpperCase()}]** ${location} - ${finding.title}`,
    `  - why: ${finding.explanation}`,
    `  - fix: ${finding.suggestion}`,
  ];
}

function renderFindingsByFile(review: CodeReview): string[] {
  if (review.findings.length === 0) {
    return ["No findings."];
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of review.findings) {
    const existing = byFile.get(finding.file);
    if (existing) {
      existing.push(finding);
    } else {
      byFile.set(finding.file, [finding]);
    }
  }

  const lines: string[] = [];
  for (const [file, findings] of byFile) {
    lines.push(`### ${file}`, "");
    for (const finding of findings) {
      lines.push(...renderFinding(finding), "");
    }
  }

  return lines;
}

/** Renders a `CodeReview` as the PR comment body: criteria table, then findings grouped by file. */
export function renderReviewMarkdown(review: CodeReview): string {
  return [
    "## AI Code Review",
    "",
    ...renderCriteriaTable(review),
    "",
    review.summary,
    "",
    ...renderFindingsByFile(review),
  ].join("\n");
}
