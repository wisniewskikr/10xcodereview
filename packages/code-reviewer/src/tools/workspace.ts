/**
 * The workspace boundary: the one place that decides which paths the agent's
 * tools may touch.
 *
 * Every tool goes through a `Workspace`, and the root is captured by closure
 * when the tools are built, so there is no code path that produces an
 * unguarded tool. Rejections are thrown - the AI SDK turns a throw inside a
 * tool into a `tool-error` part the model reads and routes around.
 */

import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Directory names no tool may enter. Not just noise that costs tokens: a real
 * run spent half its step budget reading node_modules/ai internals instead of
 * the file under review, so the skip is enforced in the guard where all three
 * tools share it, not only when filtering a listing.
 */
export const skippedDirectories: ReadonlySet<string> = new Set(["node_modules", ".git", "dist"]);

/** 256 KiB - comfortably more than any source file, far less than a bundle. */
const defaultMaxFileBytes = 256 * 1024;

/** Enough matches to be useful, few enough to leave room for the answer. */
const defaultMaxSearchResults = 40;

export interface WorkspaceLimits {
  /** Largest prefix of a single file a tool will return. */
  maxFileBytes?: number;
  /** Largest number of matches a single search returns. */
  maxSearchResults?: number;
}

export interface WorkspaceReadResult {
  /** The file text, or its first `bytesRead` bytes when the cap bit. */
  text: string;
  /** True when `text` is only a prefix of the file. */
  truncated: boolean;
  bytesRead: number;
  totalBytes: number;
}

export interface Workspace {
  /** The realpath'd root. Every accessible path lies at or beneath it. */
  readonly root: string;
  readonly maxFileBytes: number;
  readonly maxSearchResults: number;
  /** Absolute path for `inputPath`, or a throw if it escapes the root. */
  resolve(inputPath: string): string;
  /** Reads a UTF-8 text file, capped at `maxFileBytes`. */
  readTextFile(inputPath: string): WorkspaceReadResult;
  /** True when this path holds credentials and is off limits regardless of the root. */
  isDenied(inputPath: string): boolean;
}

/**
 * `.env` sits inside this very package, so root confinement alone would happily
 * read a live API key into the prompt and from there into `logs/*.log`. Deny it
 * by name as well as by location.
 */
function isSecretFileName(name: string): boolean {
  if (name === ".env.example" || name === ".env.sample" || name === ".env.template") {
    return false;
  }
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Realpath of `target`, tolerating a target that does not exist yet: resolves
 * the deepest existing ancestor and re-appends the rest. Without this, a
 * containment check on a nonexistent path could only throw ENOENT, and the
 * caller could not tell "outside the workspace" from "not there".
 */
function realpathOfNearestExisting(target: string): string {
  let current = target;
  const trailing: string[] = [];

  for (;;) {
    try {
      return resolve(realpathSync(current), ...[...trailing].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return target;
      }
      trailing.push(basename(current));
      current = parent;
    }
  }
}

/** Windows paths compare case-insensitively; comparing them exactly rejects valid paths. */
function forComparison(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function contains(root: string, candidate: string): boolean {
  const left = forComparison(root);
  const right = forComparison(candidate);
  // The trailing separator matters: without it "/work" would contain "/workspace".
  return right === left || right.startsWith(left.endsWith(sep) ? left : left + sep);
}

export function createWorkspace(root: string, limits: WorkspaceLimits = {}): Workspace {
  const realRoot = realpathOfNearestExisting(resolve(root));
  const maxFileBytes = limits.maxFileBytes ?? defaultMaxFileBytes;
  const maxSearchResults = limits.maxSearchResults ?? defaultMaxSearchResults;

  function isDenied(inputPath: string): boolean {
    return isSecretFileName(basename(inputPath));
  }

  /**
   * The first skipped segment below the root, if the path crosses one. Segments
   * above the root are not this workspace's business - a root that itself sits
   * inside a "dist" directory is perfectly legitimate.
   */
  function skippedSegment(absolute: string): string | undefined {
    const segments = relative(realRoot, absolute).split(sep);
    return segments.find((segment) => skippedDirectories.has(segment));
  }

  function resolvePath(inputPath: string): string {
    const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(realRoot, inputPath);

    // Check containment against the *real* path: a symlink inside the workspace
    // can point anywhere, and a string prefix test would never notice.
    if (!contains(realRoot, realpathOfNearestExisting(absolute))) {
      throw new Error(
        `"${inputPath}" is outside the workspace. This reviewer may only read files at or ` +
          `beneath ${realRoot}. Pass a path relative to that directory.`,
      );
    }

    const skipped = skippedSegment(absolute);
    if (skipped !== undefined) {
      throw new Error(
        `"${inputPath}" is under ${skipped}, which this reviewer never reads. ` +
          `Stay in the project's own sources - dependencies and build output are out of scope.`,
      );
    }

    if (isDenied(absolute)) {
      throw new Error(
        `"${inputPath}" holds credentials and is never readable, even inside the workspace. ` +
          `Review the code that uses it instead.`,
      );
    }

    return absolute;
  }

  function readTextFile(inputPath: string): WorkspaceReadResult {
    const absolute = resolvePath(inputPath);

    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      throw new Error(`No file at "${inputPath}" relative to the workspace root ${realRoot}.`);
    }

    if (stats.isDirectory()) {
      throw new Error(`"${inputPath}" is a directory. Use listDirectory to see what is in it.`);
    }

    const totalBytes = stats.size;
    const truncated = totalBytes > maxFileBytes;
    const buffer = truncated ? readPrefix(absolute, maxFileBytes) : readFileSync(absolute);

    if (buffer.includes(0)) {
      throw new Error(`"${inputPath}" is a binary file, not reviewable text.`);
    }

    let text = buffer.toString("utf8");
    if (truncated) {
      // The cap can land mid-character; drop the replacement char that leaves.
      text = text.replace(/\uFFFD+$/u, "");
    } else if (text.includes("\uFFFD")) {
      throw new Error(`"${inputPath}" is not valid UTF-8 text.`);
    }

    return { text, truncated, bytesRead: buffer.length, totalBytes };
  }

  return { root: realRoot, maxFileBytes, maxSearchResults, resolve: resolvePath, readTextFile, isDenied };
}

function readPrefix(absolute: string, byteCount: number): Buffer {
  const buffer = Buffer.alloc(byteCount);
  const handle = openSync(absolute, "r");
  try {
    const read = readSync(handle, buffer, 0, byteCount, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(handle);
  }
}
