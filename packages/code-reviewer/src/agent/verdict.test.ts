import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Criteria } from "../schemas/code-review.js";
import { computeVerdict } from "./verdict.js";

function criteria(overrides: Partial<Record<keyof Criteria, number>> = {}): Criteria {
  const grade = (key: keyof Criteria, fallback: number) => overrides[key] ?? fallback;

  return {
    implementationCorrectness: { grade: grade("implementationCorrectness", 10), justification: "" },
    idiomaticity: { grade: grade("idiomaticity", 10), justification: "" },
    complexity: { grade: grade("complexity", 10), justification: "" },
    testCoverage: { grade: grade("testCoverage", 10), justification: "" },
    documentation: { grade: grade("documentation", 10), justification: "" },
    securityAndSafety: { grade: grade("securityAndSafety", 10), justification: "" },
  };
}

describe("computeVerdict", () => {
  it("passes on all-high grades", () => {
    assert.equal(computeVerdict(criteria()), "passed");
  });

  it("fails on a single criterion at or below 4", () => {
    assert.equal(computeVerdict(criteria({ complexity: 4 })), "failed");
  });

  it("fails on securityAndSafety at or below 6 even when every other grade is 10", () => {
    assert.equal(computeVerdict(criteria({ securityAndSafety: 6 })), "failed");
  });

  it("passes at exactly the boundary: 5 elsewhere, security at 7", () => {
    assert.equal(
      computeVerdict(
        criteria({
          implementationCorrectness: 5,
          idiomaticity: 5,
          complexity: 5,
          testCoverage: 5,
          documentation: 5,
          securityAndSafety: 7,
        }),
      ),
      "passed",
    );
  });
});
