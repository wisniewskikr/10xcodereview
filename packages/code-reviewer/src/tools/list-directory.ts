import { tool } from "ai";
import { readdirSync } from "node:fs";
import { z } from "zod";
import { skippedDirectories, type Workspace } from "./workspace.js";

export function createListDirectoryTool(workspace: Workspace) {
  return tool({
    description:
      "List the entries of one directory in the workspace, non-recursively. " +
      "Use it to orient yourself instead of guessing at paths. " +
      `${[...skippedDirectories].join(", ")} and credential files are not listed.`,
    inputSchema: z.object({
      path: z
        .string()
        .default(".")
        .describe('Directory path relative to the workspace root. "." is the root itself.'),
    }),
    execute: ({ path }): string => {
      const absolute = workspace.resolve(path);

      let entries;
      try {
        entries = readdirSync(absolute, { withFileTypes: true });
      } catch {
        throw new Error(`No directory at "${path}" relative to the workspace root ${workspace.root}.`);
      }

      const listed = entries
        .filter((entry) => !(entry.isDirectory() && skippedDirectories.has(entry.name)))
        .filter((entry) => !workspace.isDenied(entry.name))
        .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
        .sort((left, right) => {
          if (left.isDirectory !== right.isDirectory) {
            return left.isDirectory ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });

      if (listed.length === 0) {
        return `${path} is empty.`;
      }

      const rows = listed.map((entry) => `${entry.isDirectory ? "[dir] " : "[file]"} ${entry.name}`);
      return `${path}\n${rows.join("\n")}`;
    },
  });
}
