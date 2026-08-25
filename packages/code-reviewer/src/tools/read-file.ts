import { tool } from "ai";
import { z } from "zod";
import type { Workspace } from "./workspace.js";

/**
 * Line-numbers the text before returning it. The finding schema asks the model
 * for a line number, and a model counting newlines by hand gets them wrong.
 */
function withLineNumbers(lines: readonly string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, offset) => `${String(firstLine + offset).padStart(width, " ")} | ${line}`)
    .join("\n");
}

export function createReadFileTool(workspace: Workspace) {
  return tool({
    description:
      "Read a UTF-8 text file from the workspace and get it back with line numbers. " +
      "Paths are relative to the workspace root. Use this before judging any file, " +
      "including the one under review.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file, relative to the workspace root"),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("First line to return, 1-based. Omit to start at line 1."),
      endLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Last line to return, inclusive. Omit to read to the end of the file."),
    }),
    execute: ({ path, startLine, endLine }): string => {
      const file = workspace.readTextFile(path);
      const lines = file.text.split("\n");

      const from = startLine ?? 1;
      const to = Math.min(endLine ?? lines.length, lines.length);

      if (from > lines.length) {
        throw new Error(`"${path}" has ${lines.length} line(s); startLine ${from} is past the end.`);
      }
      if (from > to) {
        throw new Error(`startLine ${from} is after endLine ${to}.`);
      }

      const header = `${path} (lines ${from}-${to} of ${lines.length})`;
      const notice = file.truncated
        ? `\n\n[truncated: this is the first ${file.bytesRead} of ${file.totalBytes} bytes - the file continues past the last line shown]`
        : "";

      return `${header}\n${withLineNumbers(lines.slice(from - 1, to), from)}${notice}`;
    },
  });
}
