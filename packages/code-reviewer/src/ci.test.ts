import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { runCi } from "./ci.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const passingCriteria = {
  implementationCorrectness: { grade: 9, justification: "Solid." },
  idiomaticity: { grade: 9, justification: "Fits in." },
  complexity: { grade: 9, justification: "Flat." },
  testCoverage: { grade: 9, justification: "Covered." },
  documentation: { grade: 9, justification: "Clear." },
  securityAndSafety: { grade: 9, justification: "Fine." },
};

function makeWorkspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "target.ts"), "export const answer = 42;\n", "utf8");
  return root;
}

function makeCommentPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-comment-"));
  return join(dir, "comment.md");
}

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

describe("runCi", () => {
  it("produces a passing verdict and a comment file for a clean review", async () => {
    const commentPath = makeCommentPath();
    const model = respondingWith(
      JSON.stringify({ summary: "Looks good.", criteria: passingCriteria, findings: [] }),
    );

    const result = await runCi({
      workspace: makeWorkspaceRoot(),
      title: "Add a helper",
      diff: "+export const answer = 42;",
      commentPath,
      maxSteps: 3,
      model,
    });

    assert.equal(result.verdict, "passed");
    assert.ok(readFileSync(commentPath, "utf8").includes("## AI Code Review"));
  });

  it("produces a failing verdict via a low grade", async () => {
    const commentPath = makeCommentPath();
    const failingCriteria = { ...passingCriteria, implementationCorrectness: { grade: 2, justification: "Broken." } };
    const model = respondingWith(
      JSON.stringify({ summary: "Bug found.", criteria: failingCriteria, findings: [] }),
    );

    const result = await runCi({
      workspace: makeWorkspaceRoot(),
      title: "Add a helper",
      diff: "+export const answer = 42;",
      commentPath,
      maxSteps: 3,
      model,
    });

    assert.equal(result.verdict, "failed");
  });

  it("produces a review verdict and never throws when the model output is invalid", async () => {
    const commentPath = makeCommentPath();
    const model = respondingWith("not json");

    const result = await runCi({
      workspace: makeWorkspaceRoot(),
      title: "Add a helper",
      diff: "+export const answer = 42;",
      commentPath,
      maxSteps: 3,
      model,
    });

    assert.equal(result.verdict, "review");
    assert.ok(readFileSync(commentPath, "utf8").includes("invalid-output"));
  });
});
