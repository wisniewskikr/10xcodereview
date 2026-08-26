import type { Criteria } from "../schemas/code-review.js";

/**
 * Pure pass/fail decision from six graded criteria. No I/O, no knowledge of
 * labels or GitHub - the workflow-facing label string mapping happens at the
 * CI entrypoint and workflow layers, not here.
 */
export function computeVerdict(criteria: Criteria): "passed" | "failed" {
  const grades = Object.values(criteria).map((criterion) => criterion.grade);

  if (grades.some((grade) => grade <= 4)) {
    return "failed";
  }

  if (criteria.securityAndSafety.grade <= 6) {
    return "failed";
  }

  return "passed";
}
