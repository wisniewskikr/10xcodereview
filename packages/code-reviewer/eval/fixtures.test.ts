import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Cheap guard that the `react19-migration` fixture is well-formed before any
 * model is ever called. If this fails, `npm run eval` would be scoring garbage.
 */

const fixtureDir = join(import.meta.dirname, "fixtures", "react19-migration");

function read(relPath: string): string {
  return readFileSync(join(fixtureDir, relPath), "utf8");
}

describe("react19-migration fixture", () => {
  it("expected-flaws.json is an array of exactly 3 flaws with unique ids", () => {
    const flaws = JSON.parse(read("expected-flaws.json")) as Array<{ id: string; file: string }>;

    assert.ok(Array.isArray(flaws), "expected-flaws.json must be a JSON array");
    assert.equal(flaws.length, 3);

    const ids = flaws.map((flaw) => flaw.id);
    assert.equal(new Set(ids).size, 3, `flaw ids must be unique, got ${ids.join(", ")}`);

    for (const flaw of flaws) {
      assert.equal(
        flaw.file,
        "src/components/UserActivityFeed.tsx",
        "every flaw points at the migrated component",
      );
    }
  });

  it("change.diff is a non-empty diff, touches no packages/ path, and migrates to hooks", () => {
    const diff = read("change.diff");

    assert.ok(diff.trim().length > 0, "change.diff must not be empty");
    assert.doesNotMatch(
      diff,
      /^\+\+\+ b\/packages\//m,
      "diffTarget strips packages/ hunks - no fixture path may live there",
    );
    assert.match(diff, /useEffect/, "the diff must show the hooks migration");
  });

  it("the component and its stub imports exist on disk and are non-empty", () => {
    for (const relPath of [
      "src/components/UserActivityFeed.tsx",
      "src/lib/activity-stream.ts",
      "src/lib/api.ts",
    ]) {
      assert.ok(read(relPath).trim().length > 0, `${relPath} must exist and be non-empty`);
    }
  });
});
