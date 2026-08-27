import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { computeVerdict } from "../src/agent/index.js";
import type { CodeReview } from "../src/agent/index.js";
import CodeReviewerProvider from "./provider.js";

/**
 * Fully offline: exercises the provider -> review -> verdict path with the
 * deterministic mock model, so `npm test` proves the eval pipeline works
 * without an API key.
 */

const diff = readFileSync(
  join(import.meta.dirname, "fixtures", "react19-migration", "change.diff"),
  "utf8",
);

describe("CodeReviewerProvider (mock)", () => {
  it("returns a review that fails the verdict with at least three findings", async () => {
    const provider = new CodeReviewerProvider({ config: { mock: true } });

    const response = await provider.callApi("", {
      vars: {
        title: "Migrate UserActivityFeed from a React 16 class component to React 19 hooks",
        description: "class -> function, lifecycle -> effects, createRoot, React 16 -> 19",
        diff,
      },
    });

    assert.equal(response.error, undefined, response.error ?? "");
    assert.equal(typeof response.output, "string");

    const review = JSON.parse(response.output as string) as CodeReview;

    assert.equal(computeVerdict(review.criteria), "failed");
    assert.ok(review.findings.length >= 3, `expected >= 3 findings, got ${review.findings.length}`);
    assert.equal(response.metadata?.verdict, "failed");
    assert.equal(response.metadata?.findingCount, review.findings.length);
  });
});
