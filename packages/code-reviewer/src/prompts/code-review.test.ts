import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCodeReviewPrompt } from "./code-review.js";

describe("buildCodeReviewPrompt (diff target)", () => {
  it("includes the title and fences the diff", () => {
    const prompt = buildCodeReviewPrompt({
      kind: "diff",
      title: "Add averageOf helper",
      diff: "+export function averageOf() {}",
    });

    assert.ok(prompt.includes("Add averageOf helper"));
    assert.ok(prompt.includes("```diff"));
    assert.ok(prompt.includes("+export function averageOf() {}"));
  });

  it("includes the description when present", () => {
    const prompt = buildCodeReviewPrompt({
      kind: "diff",
      title: "Add averageOf helper",
      description: "Fixes the off-by-one in the loop.",
      diff: "+export function averageOf() {}",
    });

    assert.ok(prompt.includes("Fixes the off-by-one in the loop."));
  });

  it("omits the description block when absent", () => {
    const prompt = buildCodeReviewPrompt({
      kind: "diff",
      title: "Add averageOf helper",
      diff: "+export function averageOf() {}",
    });

    assert.equal(prompt.includes("undefined"), false);
  });
});
