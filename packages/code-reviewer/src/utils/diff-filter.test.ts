import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excludeDirectoryFromDiff } from "./diff-filter.js";

function fileBlock(path: string, body = "@@ -1 +1 @@\n-old\n+new\n"): string {
  return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
}

describe("excludeDirectoryFromDiff", () => {
  it("drops a hunk whose path is under the excluded directory", () => {
    const diff = fileBlock("packages/code-reviewer/src/ci.ts");

    assert.equal(excludeDirectoryFromDiff(diff, "packages"), "");
  });

  it("keeps a hunk outside the excluded directory", () => {
    const diff = fileBlock("src/index.ts");

    assert.equal(excludeDirectoryFromDiff(diff, "packages"), diff);
  });

  it("keeps some files and drops others in a multi-file diff", () => {
    const kept = fileBlock("src/index.ts");
    const dropped = fileBlock("packages/code-reviewer/src/ci.ts");
    const diff = kept + dropped;

    assert.equal(excludeDirectoryFromDiff(diff, "packages"), kept);
  });

  it("does not match a directory name that only shares a prefix", () => {
    const diff = fileBlock("packages-legacy/index.ts");

    assert.equal(excludeDirectoryFromDiff(diff, "packages"), diff);
  });

  it("leaves diff text with no recognizable file header untouched", () => {
    const diff = "+export const answer = 42;";

    assert.equal(excludeDirectoryFromDiff(diff, "packages"), diff);
  });

  it("drops a renamed file whose new path moved into the excluded directory", () => {
    const diff = "diff --git a/src/old.ts b/packages/code-reviewer/src/new.ts\nsimilarity index 100%\n";

    assert.equal(excludeDirectoryFromDiff(diff, "packages"), "");
  });
});
