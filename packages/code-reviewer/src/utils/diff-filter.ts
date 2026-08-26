/**
 * Drops per-file hunks from a unified diff. Used to keep the reviewer from
 * grading its own source: `packages/` is where this very package lives, so a
 * PR that touches it must not turn into the model reviewing itself.
 */

const gitDiffHeader = /^diff --git a\/(\S+) b\/(\S+)/;

/**
 * Splits on `diff --git` boundaries so a directory can be excluded per file
 * rather than by a blind text search, which could also match a line *inside*
 * a hunk (e.g. a diff that mentions "packages/" in a comment or string).
 */
export function excludeDirectoryFromDiff(diff: string, directory: string): string {
  const prefix = `${directory}/`;
  const blocks = diff.split(/(?=^diff --git )/m);

  return blocks
    .filter((block) => {
      const match = gitDiffHeader.exec(block);
      // No recognizable header - not a per-file block we can attribute to a
      // directory, so leave it in rather than risk dropping real content.
      if (match === null) {
        return true;
      }
      const aPath = match[1] ?? "";
      const bPath = match[2] ?? "";
      return !(aPath.startsWith(prefix) || bPath.startsWith(prefix));
    })
    .join("");
}
