/**
 * The agent's read-only tool surface.
 *
 * The workspace is captured by closure here, so the agent module never sees an
 * unbound tool and no caller can construct one without a boundary.
 */

import { createListDirectoryTool } from "./list-directory.js";
import { createReadFileTool } from "./read-file.js";
import { createSearchTool } from "./search.js";
import type { Workspace } from "./workspace.js";

export function createFileTools(workspace: Workspace) {
  return {
    readFile: createReadFileTool(workspace),
    listDirectory: createListDirectoryTool(workspace),
    search: createSearchTool(workspace),
  };
}

export type FileTools = ReturnType<typeof createFileTools>;

export { createWorkspace, type Workspace, type WorkspaceLimits } from "./workspace.js";
