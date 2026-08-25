import { Output, generateText } from "ai";
import {
  buildCodeReviewPrompt,
  codeReviewInstructionVariants,
  defaultPromptVariant,
} from "../prompts/code-review.js";
import { codeReviewSchema, type CodeReview } from "../schemas/code-review.js";
import { config } from "../utils/config.js";
import { log } from "../utils/logger.js";
import { createReviewModel } from "./model.js";

export type { CodeReview, Finding } from "../schemas/code-review.js";

export async function reviewCode(input: {
  fileName: string;
  code: string;
}): Promise<CodeReview> {
  log.info(`Reviewing ${input.fileName} with ${config.model}`);

  const { output, usage } = await generateText({
    model: createReviewModel(config.model),
    instructions: codeReviewInstructionVariants[defaultPromptVariant],
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
