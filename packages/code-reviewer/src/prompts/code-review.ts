/**
 * Prompts for the code review. Edit the text here - no code changes needed.
 *
 * Instructions are a keyed record of named variants rather than one constant, so
 * a prompt eval is a loop over the keys and every variant is a reviewable diff.
 */

const defaultInstructions = [
  "You are a meticulous senior software engineer reviewing a code change.",
  "Report only real problems: bugs, security holes, data loss, race conditions,",
  "misleading names, and dead or duplicated logic.",
  "Do not report formatting, style preferences, or anything a linter already catches.",
  "Every finding must name the exact line and explain how it fails in practice.",
  "If the code is fine, return an empty list of findings and say so in the summary.",
].join(" ");

const evidenceFirstInstructions = [
  "You are a code reviewer who reports only what you can prove from the code in front of you.",
  "Before you report anything, check it with your tools: read the file, read the modules it",
  "imports, and search the workspace for the callers of any contract you are about to question.",
  "Drop every suspicion you could not corroborate that way - on this review a confident guess",
  "is worse than silence.",
  "Prefer three findings you verified over ten you assumed.",
  "Name the exact line, and in the explanation say which file, caller, or definition convinced you.",
  "Formatting, style, and anything a linter catches are out of scope.",
  "If nothing survives that bar, return an empty list of findings and say in the summary what you checked.",
].join(" ");

/** Named instruction variants. Add a key here to make it available to an eval. */
export const codeReviewInstructionVariants = {
  default: defaultInstructions,
  "evidence-first": evidenceFirstInstructions,
} as const;

export type CodeReviewPromptVariant = keyof typeof codeReviewInstructionVariants;

export const defaultPromptVariant: CodeReviewPromptVariant = "default";

/**
 * What a single review call is pointed at.
 *
 * Defined here rather than in the agent module because the prompt builder is
 * its only structural consumer; `agent/` re-exports it as the public name.
 */
export type CodeReviewTarget =
  | { kind: "file"; path: string }
  | { kind: "inline"; fileName: string; code: string };

/**
 * Builds the user message for a review target.
 *
 * The two kinds get materially different messages on purpose: an inline target
 * carries its code in the prompt, while a file target deliberately does not, so
 * the agent has to reach for its tools to see anything at all.
 */
export function buildCodeReviewPrompt(target: CodeReviewTarget): string {
  switch (target.kind) {
    case "inline":
      return [
        `Review the following file: ${target.fileName}`,
        "",
        "```",
        target.code,
        "```",
        "",
        "This snippet is the whole target and it is not on disk - there is no file to read.",
      ].join("\n");

    case "file":
      return [
        `Review the file at this workspace-relative path: ${target.path}`,
        "",
        "Its contents are deliberately not included here - read it with your readFile tool first.",
        "Then follow whatever you need to judge it: the modules it imports, the callers of what",
        "it exports, a sibling type whose shape you are unsure of.",
        "Report findings on that file only; everything else you read is context.",
      ].join("\n");
  }
}
