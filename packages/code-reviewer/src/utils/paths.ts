import { resolve } from "node:path";

/** Project root: two levels up from src/utils/. */
export const projectRoot = resolve(import.meta.dirname, "..", "..");

export function fromProjectRoot(...segments: string[]): string {
  return resolve(projectRoot, ...segments);
}
