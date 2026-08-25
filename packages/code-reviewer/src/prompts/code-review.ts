/**
 * Prompts for the code review. Edit the text here - no code changes needed.
 */

export const codeReviewInstructions = [
  "You are a meticulous senior software engineer reviewing a code change.",
  "Report only real problems: bugs, security holes, data loss, race conditions,",
  "misleading names, and dead or duplicated logic.",
  "Do not report formatting, style preferences, or anything a linter already catches.",
  "Every finding must name the exact line and explain how it fails in practice.",
  "If the code is fine, return an empty list of findings and say so in the summary.",
].join(" ");

export function buildCodeReviewPrompt(input: {
  fileName: string;
  code: string;
}): string {
  return [
    `Review the following file: ${input.fileName}`,
    "",
    "```",
    input.code,
    "```",
  ].join("\n");
}
