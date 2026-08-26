/**
 * The package's public surface. One import path for every consumer - the CLI in
 * this package and, later, the prompt-eval harness - so internals stay free to
 * move without breaking anyone.
 *
 * This module is side-effect free: importing it reads no .env, constructs no
 * model, and touches no filesystem. Nothing happens until you call a factory.
 */

export {
  createCodeReviewAgent,
  createCodeReviewer,
  diffTarget,
  fileTarget,
  inlineTarget,
  type CodeReviewAgentOptions,
  type CodeReviewer,
  type CodeReviewerOptions,
  type CodeReviewTarget,
} from "./code-review-agent.js";

export { CodeReviewError, type CodeReviewErrorReason } from "./errors.js";

export { computeVerdict } from "./verdict.js";

export { renderReviewMarkdown } from "../cli/render-markdown.js";

export {
  codeReviewSchema,
  findingSchema,
  type CodeReview,
  type Criteria,
  type Criterion,
  type Finding,
} from "../schemas/code-review.js";

export {
  codeReviewInstructionVariants,
  defaultPromptVariant,
  type CodeReviewPromptVariant,
} from "../prompts/code-review.js";
