import { tool } from "ai";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { skippedDirectories, type Workspace } from "./workspace.js";

/** Longest snippet returned per match. Long minified lines are not worth the tokens. */
const maxMatchTextLength = 200;

/**
 * A window of the line around the match.
 *
 * Slicing from the start instead would report a hit whose snippet never
 * contains the query - which is exactly the long-line case the cap exists for,
 * and the model has no other way to see why the line matched.
 */
function excerpt(line: string, matchIndex: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxMatchTextLength) {
    return trimmed;
  }

  const lead = line.length - line.trimStart().length;
  const indexInTrimmed = Math.max(0, matchIndex - lead);

  // Leave a third of the window before the match so it reads in context.
  const start = Math.min(
    Math.max(0, indexInTrimmed - Math.floor(maxMatchTextLength / 3)),
    trimmed.length - maxMatchTextLength,
  );
  const end = start + maxMatchTextLength;

  return `${start > 0 ? "..." : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "..." : ""}`;
}

export interface SearchMatch {
  /** Workspace-relative path, always with forward slashes. */
  path: string;
  /** 1-based line number. */
  line: number;
  text: string;
}

export interface SearchOutcome {
  matches: SearchMatch[];
  /** True when the result cap stopped the search before the workspace was exhausted. */
  capped: boolean;
  filesScanned: number;
}

/**
 * Translates a shell-style glob into a regexp over a workspace-relative path.
 * `*` and `?` stop at a separator, `**` spans them.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);

    if (char === "*" && pattern.charAt(index + 1) === "*") {
      index += 1;
      if (pattern.charAt(index + 1) === "/") {
        // "**/" must also match zero directories, so "**/x.ts" finds "x.ts" at the root.
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`, "i");
}

/**
 * Yields every regular file under the workspace root, workspace-relative.
 *
 * Symlinks are never followed - a symlinked directory can point anywhere, and
 * the walk is the one place the guard cannot be consulted per path in advance.
 */
function* walkFiles(root: string): Generator<string> {
  const stack: string[] = ["."];

  while (stack.length > 0) {
    const relativeDir = stack.pop();
    if (relativeDir === undefined) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const relativePath = relativeDir === "." ? entry.name : `${relativeDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) {
          stack.push(relativePath);
        }
      } else if (entry.isFile()) {
        yield relativePath;
      }
    }
  }
}

/**
 * Literal substring search across the workspace, in process.
 *
 * Deliberately not `grep` or `rg`: neither is reliably present on Windows,
 * where this package is developed.
 */
export function searchWorkspace(
  workspace: Workspace,
  options: { query: string; filePattern?: string; caseSensitive?: boolean },
): SearchOutcome {
  const { query, filePattern, caseSensitive = false } = options;

  if (query.length === 0) {
    throw new Error("The search query is empty. Pass the text you are looking for.");
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  const pathFilter = filePattern === undefined ? undefined : globToRegExp(filePattern);
  const matchBasenameOnly = filePattern !== undefined && !filePattern.includes("/");

  const matches: SearchMatch[] = [];
  let filesScanned = 0;

  for (const relativePath of walkFiles(workspace.root)) {
    if (pathFilter !== undefined) {
      const subject = matchBasenameOnly
        ? (relativePath.split("/").at(-1) ?? relativePath)
        : relativePath;
      if (!pathFilter.test(subject)) {
        continue;
      }
    }

    let file;
    try {
      // Every candidate goes back through the guard: binary files, credential
      // files, and anything that resolved outside the root throw and are skipped.
      file = workspace.readTextFile(relativePath);
    } catch {
      continue;
    }

    filesScanned += 1;

    const lines = file.text.split("\n");
    for (const [offset, line] of lines.entries()) {
      const haystack = caseSensitive ? line : line.toLowerCase();
      const matchIndex = haystack.indexOf(needle);
      if (matchIndex === -1) {
        continue;
      }

      matches.push({
        path: relativePath,
        line: offset + 1,
        text: excerpt(line, matchIndex),
      });

      if (matches.length >= workspace.maxSearchResults) {
        return { matches, capped: true, filesScanned };
      }
    }
  }

  return { matches, capped: false, filesScanned };
}

export function createSearchTool(workspace: Workspace) {
  return tool({
    description:
      "Search the workspace for a literal string - not a regular expression. " +
      "Use it to find the callers of a function, the definition of a type, or every " +
      "place a contract is relied on. Returns workspace-relative paths with line numbers.",
    inputSchema: z.object({
      query: z.string().min(1).describe("The exact text to look for"),
      filePattern: z
        .string()
        .optional()
        .describe(
          'Optional glob filter, e.g. "*.ts" to match by file name or "src/**/*.ts" to match by path',
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("Match case exactly. Defaults to false."),
    }),
    execute: ({ query, filePattern, caseSensitive }): SearchOutcome =>
      searchWorkspace(workspace, { query, filePattern, caseSensitive }),
  });
}
