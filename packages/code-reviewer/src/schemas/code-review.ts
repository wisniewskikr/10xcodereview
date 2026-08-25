/**
 * The shape of a code review. Lives on its own so the agent, the CLI renderer,
 * and a future eval scorer can all import it without pulling in the AI SDK.
 *
 * The `.describe()` annotations are prompt surface - the model reads them.
 */

import { z } from "zod";

export const findingSchema = z.object({
  line: z.number().int().positive().nullable().describe("Line number, or null if it applies to the whole file"),
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().describe("One short sentence naming the problem"),
  explanation: z.string().describe("How this fails in practice"),
  suggestion: z.string().describe("The concrete fix"),
});

export const codeReviewSchema = z.object({
  summary: z.string().describe("Two or three sentences on the overall state of the file"),
  findings: z.array(findingSchema),
});

export type Finding = z.infer<typeof findingSchema>;
export type CodeReview = z.infer<typeof codeReviewSchema>;
