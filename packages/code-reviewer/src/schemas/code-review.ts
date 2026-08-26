/**
 * The shape of a code review. Lives on its own so the agent, the CLI renderer,
 * and a future eval scorer can all import it without pulling in the AI SDK.
 *
 * The `.describe()` annotations are prompt surface - the model reads them.
 */

import { z } from "zod";

export const findingSchema = z.object({
  file: z.string().describe("Workspace-relative path of the file this finding applies to"),
  line: z.number().int().positive().nullable().describe("Line number, or null if it applies to the whole file"),
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().describe("One short sentence naming the problem"),
  explanation: z.string().describe("How this fails in practice"),
  suggestion: z.string().describe("The concrete fix"),
});

function criterion(oneOutOfTen: string, tenOutOfTen: string) {
  return z.object({
    grade: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe(`1/10: ${oneOutOfTen}. 10/10: ${tenOutOfTen}.`),
    justification: z.string(),
  });
}

export const criteriaSchema = z.object({
  implementationCorrectness: criterion(
    "Wrong results, obvious bugs, edge cases ignored",
    "Does exactly what it promises, edge cases handled",
  ),
  idiomaticity: criterion(
    "Foreign style, fights the language and the codebase",
    "Blends in - reads like it was always there",
  ),
  complexity: criterion(
    "A maze: deep nesting, huge functions, hidden tricks",
    "A straight road: small, flat, easy to follow",
  ),
  testCoverage: criterion(
    "No seatbelt where the car goes fastest",
    "Risky paths covered with meaningful tests",
  ),
  documentation: criterion(
    "Cryptic names, no comments, stale docs",
    "Clear names, comments where needed, docs updated",
  ),
  securityAndSafety: criterion(
    "Leaked secrets, injection holes, destructive operations",
    "Inputs validated, secrets safe, no destructive surprises",
  ),
});

export const codeReviewSchema = z.object({
  summary: z.string().describe("Two or three sentences on the overall state of the file"),
  criteria: criteriaSchema,
  findings: z.array(findingSchema),
});

export type Finding = z.infer<typeof findingSchema>;
export type Criterion = z.infer<typeof criteriaSchema>["implementationCorrectness"];
export type Criteria = z.infer<typeof criteriaSchema>;
export type CodeReview = z.infer<typeof codeReviewSchema>;
