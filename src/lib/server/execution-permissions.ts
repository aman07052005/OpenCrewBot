/** Only these explicitly read-only built-in tools can run in task sessions. */
export const EXECUTION_SAFE_TOOL_NAMES = new Set(["web_search", "read_page", "crawl_site", "execute_typescript"]);

const CATEGORIES = ["read", "edit", "mcp", "execute", "other"] as const;
type Policy = "allow" | "deny";
type Category = (typeof CATEGORIES)[number];

export interface ExecutionPermissionManager {
  setForCategory(input: { category: Category; policy: Policy }): Promise<unknown> | unknown;
}

/** Mastra tool calls outside the allowlist are resolved to a denied category. */
export function executionToolCategory(toolName: string): Category {
  return EXECUTION_SAFE_TOOL_NAMES.has(toolName) ? "read" : "other";
}

/** A task-level approval never grants permission to execute an individual tool. */
export async function restrictExecutionPermissions(permissions: ExecutionPermissionManager): Promise<void> {
  await Promise.all(CATEGORIES.map((category) => permissions.setForCategory({
    category,
    policy: category === "read" ? "allow" : "deny",
  })));
}
