import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { createCodeReviewer } from "./code-review-agent.js";
import { CodeReviewError } from "./errors.js";

/**
 * A failed review must never come back looking like a clean one - that is the
 * difference between an eval row scored "no findings" and one scored a failure.
 */

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function makeWorkspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "target.ts"), "export const answer = 42;\n", "utf8");
  return root;
}

const passingCriteria = {
  implementationCorrectness: { grade: 9, justification: "Does what it says." },
  idiomaticity: { grade: 9, justification: "Fits the codebase." },
  complexity: { grade: 9, justification: "Simple and flat." },
  testCoverage: { grade: 9, justification: "Covered." },
  documentation: { grade: 9, justification: "Clear." },
  securityAndSafety: { grade: 9, justification: "No issues." },
};

function respondingWith(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

/** A model that only ever asks for another tool call, so the budget must bite. */
function alwaysCallingTools(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `call-${Math.random().toString(36).slice(2)}`,
          toolName: "listDirectory",
          input: JSON.stringify({ path: "." }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

function reviewerOn(model: MockLanguageModelV4, maxSteps = 3) {
  return createCodeReviewer({ model, workspaceRoot: makeWorkspaceRoot(), maxSteps });
}

describe("createCodeReviewer().review", () => {
  it("returns the parsed review when the model answers in schema", async () => {
    const reviewer = reviewerOn(
      respondingWith(
        JSON.stringify({
          summary: "Looks fine.",
          criteria: passingCriteria,
          findings: [
            {
              file: "src/target.ts",
              line: 1,
              severity: "info",
              title: "Nothing wrong",
              explanation: "It does what it says.",
              suggestion: "Leave it alone.",
            },
          ],
        }),
      ),
    );

    const review = await reviewer.review({ kind: "file", path: "src/target.ts" });

    assert.equal(review.summary, "Looks fine.");
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0]?.severity, "info");
  });

  it("raises CodeReviewError rather than returning a review when the output is not JSON", async () => {
    const reviewer = reviewerOn(respondingWith("Looks fine to me, no findings."));

    await assert.rejects(
      () => reviewer.review({ kind: "file", path: "src/target.ts" }),
      (error: unknown) => {
        assert.ok(CodeReviewError.isInstance(error), "expected a CodeReviewError");
        assert.equal(error.reason, "invalid-output");
        return true;
      },
    );
  });

  it("raises CodeReviewError when the output is JSON the schema rejects", async () => {
    const reviewer = reviewerOn(respondingWith(JSON.stringify({ summary: "Missing findings." })));

    await assert.rejects(
      () => reviewer.review({ kind: "inline", fileName: "x.ts", code: "const a = 1;" }),
      (error: unknown) => {
        assert.ok(CodeReviewError.isInstance(error), "expected a CodeReviewError");
        assert.equal(error.reason, "invalid-output");
        return true;
      },
    );
  });

  it("raises step-budget-exhausted when the loop never produces the output", async () => {
    const reviewer = reviewerOn(alwaysCallingTools(), 2);

    await assert.rejects(
      () => reviewer.review({ kind: "file", path: "src/target.ts" }),
      (error: unknown) => {
        assert.ok(CodeReviewError.isInstance(error), "expected a CodeReviewError");
        assert.equal(error.reason, "step-budget-exhausted");
        assert.equal(error.steps, 2);
        return true;
      },
    );
  });

  it("raises provider-error when the model call itself fails", async () => {
    const reviewer = reviewerOn(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("upstream is down");
        },
      }),
    );

    await assert.rejects(
      () => reviewer.review({ kind: "file", path: "src/target.ts" }),
      (error: unknown) => {
        assert.ok(CodeReviewError.isInstance(error), "expected a CodeReviewError");
        assert.equal(error.reason, "provider-error");
        return true;
      },
    );
  });

  it("builds two reviewers on different models without interference", async () => {
    const first = reviewerOn(
      respondingWith(
        JSON.stringify({ summary: "First reviewer.", criteria: passingCriteria, findings: [] }),
      ),
    );
    const second = reviewerOn(
      respondingWith(
        JSON.stringify({ summary: "Second reviewer.", criteria: passingCriteria, findings: [] }),
      ),
    );

    const target = { kind: "file" as const, path: "src/target.ts" };
    const [one, two] = await Promise.all([first.review(target), second.review(target)]);

    assert.equal(one.summary, "First reviewer.");
    assert.equal(two.summary, "Second reviewer.");
  });
});
