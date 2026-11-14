import { z } from "zod";

const repo = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "Use owner/repository.");
const ref = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).optional();
const path = z.string().min(1).max(300).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "Use a repository-relative path without traversal.");
export const GitHubRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("metadata"), repository: repo }).strict(),
  z.object({ operation: z.literal("directory"), repository: repo, path: z.string().max(300).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "Use a safe repository-relative path.").default(""), ref }).strict(),
  z.object({ operation: z.literal("file"), repository: repo, path, ref }).strict(),
  z.object({ operation: z.literal("issue"), repository: repo, number: z.number().int().positive().max(1_000_000) }).strict(),
  z.object({ operation: z.literal("pull-request"), repository: repo, number: z.number().int().positive().max(1_000_000) }).strict(),
]);
export type GitHubRequest = z.infer<typeof GitHubRequestSchema>;
export type GitHubFetcher = (input: string, init: RequestInit) => Promise<Response>;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

function endpoint(request: GitHubRequest): string {
  const root = `https://api.github.com/repos/${request.repository}`;
  if (request.operation === "metadata") return root;
  if (request.operation === "directory") return `${root}/contents/${request.path}${request.ref ? `?ref=${encodeURIComponent(request.ref)}` : ""}`;
  if (request.operation === "file") return `${root}/contents/${request.path}${request.ref ? `?ref=${encodeURIComponent(request.ref)}` : ""}`;
  return `${root}/${request.operation === "issue" ? "issues" : "pulls"}/${request.number}`;
}
function source(request: GitHubRequest) {
  if (request.operation === "file") return `https://github.com/${request.repository}/blob/${request.ref ?? "HEAD"}/${request.path}`;
  if (request.operation === "directory") return `https://github.com/${request.repository}/tree/${request.ref ?? "HEAD"}/${request.path}`;
  return `https://github.com/${request.repository}`;
}
function decode(content: string): string { const bytes = Buffer.from(content.replace(/\s/g, ""), "base64"); if (bytes.length > MAX_FILE_BYTES) throw new Error("Repository file exceeds the 256 KB safety limit."); return bytes.toString("utf8"); }
export async function inspectGitHub(requestInput: unknown, options: { fetcher?: GitHubFetcher; token?: string; signal?: AbortSignal } = {}) {
  const request = GitHubRequestSchema.parse(requestInput); const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetcher(endpoint(request), { headers: { Accept: "application/vnd.github+json", "User-Agent": "OpenCrewBot", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, signal: options.signal ?? controller.signal });
    if (!response.ok) throw new Error(response.status === 404 ? "GitHub resource was not found or is not authorized." : `GitHub returned HTTP ${response.status}.`);
    const advertisedLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(advertisedLength) && advertisedLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("GitHub response exceeds the 512 KB safety limit.");
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("GitHub response exceeds the 512 KB safety limit.");
    let body: Record<string, unknown> | Array<Record<string, unknown>>;
    try { body = JSON.parse(raw) as Record<string, unknown> | Array<Record<string, unknown>>; } catch { throw new Error("GitHub returned malformed JSON."); }
    if (request.operation === "file") {
      if (Array.isArray(body) || typeof body.content !== "string" || body.encoding !== "base64") throw new Error("GitHub did not return a readable file.");
      return { integration: "github", operation: request.operation, repository: request.repository, source: source(request), file: { path: String(body.path), sha: String(body.sha), text: decode(body.content) } };
    }
    if (request.operation === "directory") {
      if (!Array.isArray(body)) throw new Error("Requested path is not a directory.");
      return { integration: "github", operation: request.operation, repository: request.repository, source: source(request), entries: body.slice(0, 100).map((item) => ({ name: String(item.name), path: String(item.path), type: String(item.type), size: typeof item.size === "number" ? item.size : null, url: typeof item.html_url === "string" ? item.html_url : null })) };
    }
    return { integration: "github", operation: request.operation, repository: request.repository, source: source(request), data: body };
  } finally { clearTimeout(timer); }
}
