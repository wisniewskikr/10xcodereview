import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { searchWorkspace } from "./search.js";
import { createWorkspace, type Workspace } from "./workspace.js";

function makeFixture(): { workspace: Workspace; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "search-test-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");

  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(root, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n", "utf8");
  writeFileSync(join(root, "src", "nested", "b.ts"), "// needle again\n", "utf8");
  writeFileSync(join(root, "src", "a.md"), "needle in markdown\n", "utf8");
  writeFileSync(join(root, "node_modules", "pkg", "c.ts"), "needle in a dependency\n", "utf8");
  writeFileSync(join(root, "dist", "d.js"), "needle in build output\n", "utf8");
  writeFileSync(join(root, ".env"), "NEEDLE_KEY=needle-secret\n", "utf8");
  writeFileSync(join(outside, "e.ts"), "needle outside the root\n", "utf8");

  return { workspace: createWorkspace(root, { maxSearchResults: 100 }), outside };
}

function tryLinkDirectory(target: string, linkPath: string): boolean {
  for (const kind of ["dir", "junction"] as const) {
    try {
      symlinkSync(target, linkPath, kind);
      return true;
    } catch {
      // Try the next kind.
    }
  }
  return false;
}

describe("searchWorkspace", () => {
  it("finds matches with the right line numbers", () => {
    const { workspace } = makeFixture();
    const outcome = searchWorkspace(workspace, { query: "other", filePattern: "*.ts" });

    assert.deepEqual(outcome.matches, [{ path: "src/a.ts", line: 2, text: "const other = 2;" }]);
    assert.equal(outcome.capped, false);
  });

  it("filters by file name when the pattern has no separator", () => {
    const { workspace } = makeFixture();
    const paths = searchWorkspace(workspace, { query: "needle", filePattern: "*.md" }).matches.map(
      (match) => match.path,
    );

    assert.deepEqual(paths, ["src/a.md"]);
  });

  it("filters by path when the pattern has a separator", () => {
    const { workspace } = makeFixture();
    const paths = searchWorkspace(workspace, {
      query: "needle",
      filePattern: "src/nested/**/*.ts",
    }).matches.map((match) => match.path);

    assert.deepEqual(paths, ["src/nested/b.ts"]);
  });

  it("matches ** across zero directories", () => {
    const { workspace } = makeFixture();
    const paths = searchWorkspace(workspace, { query: "needle", filePattern: "src/**/*.ts" })
      .matches.map((match) => match.path)
      .sort();

    assert.deepEqual(paths, ["src/a.ts", "src/nested/b.ts"]);
  });

  it("is case-insensitive by default and exact when asked", () => {
    const { workspace } = makeFixture();

    assert.equal(searchWorkspace(workspace, { query: "NEEDLE", filePattern: "*.md" }).matches.length, 1);
    assert.equal(
      searchWorkspace(workspace, { query: "NEEDLE", filePattern: "*.md", caseSensitive: true })
        .matches.length,
      0,
    );
  });

  it("honours the result cap and flags that it stopped early", () => {
    const { workspace } = makeFixture();
    const capped = createWorkspace(workspace.root, { maxSearchResults: 2 });
    const outcome = searchWorkspace(capped, { query: "needle" });

    assert.equal(outcome.matches.length, 2);
    assert.equal(outcome.capped, true);
  });

  it("never returns a path outside the root", () => {
    const { workspace, outside } = makeFixture();
    const outcome = searchWorkspace(workspace, { query: "needle" });

    assert.ok(outcome.matches.length > 0);
    for (const match of outcome.matches) {
      assert.doesNotMatch(match.path, /\.\./);
      assert.equal(workspace.resolve(match.path).startsWith(workspace.root), true);
      assert.doesNotMatch(match.text, /outside the root/);
    }
    assert.ok(outside.length > 0);
  });

  it("skips node_modules, dist, and credential files", () => {
    const { workspace } = makeFixture();
    const paths = searchWorkspace(workspace, { query: "needle" }).matches.map((match) => match.path);

    assert.equal(paths.some((path) => path.startsWith("node_modules/")), false);
    assert.equal(paths.some((path) => path.startsWith("dist/")), false);
    assert.equal(paths.includes(".env"), false);
  });

  it("does not follow a linked directory out of the root", (t) => {
    const { workspace, outside } = makeFixture();

    // A junction stands in for a symlink where the platform forbids one.
    if (!tryLinkDirectory(outside, join(workspace.root, "linked"))) {
      t.skip("this platform allows neither symlinks nor junctions unprivileged");
      return;
    }

    const paths = searchWorkspace(workspace, { query: "needle" }).matches.map((match) => match.path);
    assert.equal(paths.some((path) => path.startsWith("linked")), false);
  });

  it("shows the match even when it sits past the snippet cap", () => {
    const { workspace } = makeFixture();
    const farAway = `const padding = "${"x".repeat(400)}"; const findMeHere = 1;`;
    writeFileSync(join(workspace.root, "src", "long.ts"), `${farAway}\n`, "utf8");

    const outcome = searchWorkspace(workspace, { query: "findMeHere", filePattern: "long.ts" });

    assert.equal(outcome.matches.length, 1);
    const text = outcome.matches[0]?.text ?? "";
    assert.ok(text.includes("findMeHere"), `snippet lost the match: ${text}`);
    assert.ok(text.startsWith("..."), "expected a leading ellipsis for a mid-line window");
  });

  it("rejects an empty query", () => {
    const { workspace } = makeFixture();

    assert.throws(() => searchWorkspace(workspace, { query: "" }), /query is empty/);
  });
});
