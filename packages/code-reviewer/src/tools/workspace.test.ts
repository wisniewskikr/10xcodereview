import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWorkspace } from "./workspace.js";

/**
 * The containment boundary is a security boundary: a gap here reads the live
 * OPENROUTER_API_KEY in .env into a prompt and from there into logs/*.log.
 *
 * Fixtures assert against `workspace.root` rather than the path handed to
 * `createWorkspace`, because the constructor realpaths its root and the OS temp
 * directory is a symlink on some platforms.
 */

function makeFixture(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "workspace-test-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");

  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  writeFileSync(join(root, ".env"), "OPENROUTER_API_KEY=sk-secret\n", "utf8");
  writeFileSync(join(root, ".env.example"), "OPENROUTER_API_KEY=\n", "utf8");
  writeFileSync(join(outside, "secrets.txt"), "do not read me\n", "utf8");

  return { root, outside };
}

/**
 * Windows refuses unprivileged symlinks but allows directory junctions, and
 * realpath resolves both the same way - either one proves the escape is caught.
 * Returns the workspace-relative path that now leads outside, or undefined when
 * the platform allows neither.
 */
function linkOutside(root: string, outside: string): string | undefined {
  try {
    symlinkSync(join(outside, "secrets.txt"), join(root, "escape.txt"), "file");
    return "escape.txt";
  } catch {
    // Not permitted here; try a junction instead.
  }

  try {
    symlinkSync(outside, join(root, "linked"), "junction");
    return "linked/secrets.txt";
  } catch {
    return undefined;
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("createWorkspace().resolve", () => {
  it("resolves a relative path inside the root", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);

    assert.equal(workspace.resolve("src/index.ts"), join(workspace.root, "src", "index.ts"));
  });

  it("realpaths the root once at construction", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(join(root, "src", ".."));

    assert.equal(workspace.resolve("."), workspace.root);
  });

  it("rejects ../ traversal out of the root", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);

    assert.throws(() => workspace.resolve("../outside/secrets.txt"), /outside the workspace/);
    assert.throws(() => workspace.resolve("src/../../outside/secrets.txt"), /outside the workspace/);
  });

  it("rejects an absolute path outside the root", () => {
    const { root, outside } = makeFixture();
    const workspace = createWorkspace(root);

    assert.throws(() => workspace.resolve(join(outside, "secrets.txt")), /outside the workspace/);
  });

  it("accepts an absolute path inside the root", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);
    const target = join(workspace.root, "src", "index.ts");

    assert.equal(workspace.resolve(target), target);
  });

  it("names the workspace root in the rejection and leaks no content", () => {
    const { root, outside } = makeFixture();
    const workspace = createWorkspace(root);

    assert.throws(
      () => workspace.resolve(join(outside, "secrets.txt")),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(escapeForRegExp(workspace.root)));
        assert.doesNotMatch(message, /do not read me/);
        return true;
      },
    );
  });

  it("rejects a sibling directory whose name merely starts with the root", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);
    // "<root>-extra" shares a string prefix with the root; only the trailing
    // separator in the containment check tells them apart.
    const sibling = `${workspace.root}-extra`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "note.txt"), "nearby\n", "utf8");

    assert.throws(() => workspace.resolve(join(sibling, "note.txt")), /outside the workspace/);
  });

  it("rejects a link that points outside the root", (t) => {
    const { root, outside } = makeFixture();
    const workspace = createWorkspace(root);
    const escapeRoute = linkOutside(workspace.root, outside);

    if (escapeRoute === undefined) {
      t.skip("this platform allows neither symlinks nor junctions unprivileged");
      return;
    }

    assert.throws(() => workspace.resolve(escapeRoute), /outside the workspace/);
    assert.throws(() => workspace.readTextFile(escapeRoute), /outside the workspace/);
  });

  it("rejects a credential file even when it sits inside the root", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);

    assert.throws(() => workspace.resolve(".env"), /holds credentials/);
    assert.throws(() => workspace.readTextFile(".env"), /holds credentials/);
    // The example file carries no secret and stays readable.
    assert.ok(workspace.readTextFile(".env.example").text.length > 0);
  });
});

describe("createWorkspace().readTextFile", () => {
  it("reads a file inside the root", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);
    const file = workspace.readTextFile("src/index.ts");

    assert.equal(file.text, "export const answer = 42;\n");
    assert.equal(file.truncated, false);
  });

  it("truncates a file over the byte cap and says so", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root, { maxFileBytes: 10 });
    writeFileSync(join(workspace.root, "big.txt"), "0123456789abcdef", "utf8");

    const file = workspace.readTextFile("big.txt");

    assert.equal(file.truncated, true);
    assert.equal(file.text, "0123456789");
    assert.equal(file.bytesRead, 10);
    assert.equal(file.totalBytes, 16);
  });

  it("rejects a binary file", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);
    writeFileSync(join(workspace.root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));

    assert.throws(() => workspace.readTextFile("blob.bin"), /binary/);
  });

  it("reports a missing file by the path that was asked for", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);

    assert.throws(() => workspace.readTextFile("src/nope.ts"), /No file at "src\/nope\.ts"/);
  });

  it("points a directory read at listDirectory", () => {
    const { root } = makeFixture();
    const workspace = createWorkspace(root);

    assert.throws(() => workspace.readTextFile("src"), /listDirectory/);
  });
});
