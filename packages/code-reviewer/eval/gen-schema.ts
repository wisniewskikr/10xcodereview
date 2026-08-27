/**
 * Regenerates the JSON Schema that the promptfoo `is-json` assertion validates
 * each review against.
 *
 * Runs on every `npm run eval`, right after `npm run build` emits the compiled
 * `dist/schemas/code-review.js` this imports - so the schema on disk can never
 * drift from the Zod source of truth.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codeReviewSchema } from "../dist/schemas/code-review.js";

const outDir = join(import.meta.dirname, "schemas");
const outFile = join(outDir, "code-review.schema.json");

try {
  const jsonSchema = z.toJSONSchema(codeReviewSchema, { target: "draft-7" });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outFile}`);
} catch (error) {
  console.error(`Failed to generate ${outFile}:`, error);
  process.exit(1);
}
