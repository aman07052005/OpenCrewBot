import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRequestSchema, inspectGitHub } from "../src/lib/server/github-integration.ts";
import { redactIntegrationValue } from "../src/lib/server/integration-safety.ts";

function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

test("GitHub adapter validates repositories and bounds selected source files", async () => {
  assert.throws(() => GitHubRequestSchema.parse({ operation: "file", repository: "bad repo", path: "x.ts" }));
  assert.throws(() => GitHubRequestSchema.parse({ operation: "file", repository: "owner/repo", path: "../secret" }));
  const result = await inspectGitHub({ operation: "file", repository: "owner/repo", path: "src/a.ts", ref: "main" }, { fetcher: async (url, init) => { assert.match(url, /api\.github\.com\/repos\/owner\/repo\/contents\/src\/a\.ts/); assert.equal(init.headers.Accept, "application/vnd.github+json"); return response({ path: "src/a.ts", sha: "abc", encoding: "base64", content: Buffer.from("const x = 1").toString("base64") }); } });
  assert.equal(result.file.text, "const x = 1");
  assert.match(result.source, /github\.com\/owner\/repo/);
});

test("GitHub directory output is bounded and provider failures do not become mock data", async () => {
  const entries = Array.from({ length: 105 }, (_, index) => ({ name: `f${index}`, path: `f${index}`, type: "file", size: 1, html_url: `https://github.com/o/r/blob/main/f${index}` }));
  const result = await inspectGitHub({ operation: "directory", repository: "owner/repo", path: "" }, { fetcher: async () => response(entries) });
  assert.equal(result.entries.length, 100);
  await assert.rejects(() => inspectGitHub({ operation: "metadata", repository: "owner/repo" }, { fetcher: async () => response({ message: "no" }, 500) }), /GitHub returned HTTP 500/);
});

test("GitHub provider responses and MCP output are bounded and secret-safe", async () => {
  await assert.rejects(() => inspectGitHub({ operation: "metadata", repository: "owner/repo" }, { fetcher: async () => new Response("x".repeat(512 * 1024 + 1), { status: 200 }) }), /512 KB/);
  const redacted = redactIntegrationValue({ token: "not-for-the-browser", nested: { note: "api_key=not-for-the-browser" } });
  assert.equal(redacted.token, "[REDACTED]");
  assert.doesNotMatch(redacted.nested.note, /not-for-the-browser/);
});
