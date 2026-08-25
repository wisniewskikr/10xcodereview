import { Output, generateText } from "ai";
import { z } from "zod";
import { buildCodeReviewPrompt, codeReviewInstructions } from "../prompts/code-review.js";
import { config } from "../utils/config.js";
import { log } from "../utils/logger.js";
import { createReviewModel } from "./model.js";

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

export async function reviewCode(input: {
  fileName: string;
  code: string;
}): Promise<CodeReview> {
  log.info(`Reviewing ${input.fileName} with ${config.model}`);

  const { output, usage } = await generateText({
    model: createReviewModel(),
    instructions: codeReviewInstructions,
    prompt: buildCodeReviewPrompt(input),
    output: Output.object({ schema: codeReviewSchema }),
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    timeout: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });

  log.info(
    `Review done: ${output.findings.length} finding(s), ` +
      `${usage.inputTokens ?? 0} input + ${usage.outputTokens ?? 0} output tokens`,
  );

  return output;
}
