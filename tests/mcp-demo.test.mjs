import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { MCPClient } from "@mastra/mcp";

async function startDemo(port) {
  const child = spawn(process.execPath, ["scripts/synthetic-mcp-demo.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, OPENCREWBOT_MCP_DEMO_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Synthetic MCP demo did not start: ${output}`)), 10_000);
    child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Synthetic MCP demo exited early (${code}): ${output}`)); });
  });
  return child;
}

test("synthetic MCP demo supports real protocol discovery and a bounded read-only call", async () => {
  const port = 3031;
  const child = await startDemo(port);
  const client = new MCPClient({ id: `mcp-test-${Date.now()}`, servers: { demo: { url: new URL(`http://127.0.0.1:${port}/mcp`) } } });
  try {
    const definitions = await client.listToolDefinitions();
    assert.equal(definitions.demo.get_synthetic_product.annotations?.readOnlyHint, true);
    assert.equal(definitions.demo.calculate_synthetic_margin.annotations?.readOnlyHint, true);
    const tools = await client.listTools();
    const result = await tools.demo_get_synthetic_product.execute({ sku: "DEMO-100" });
    assert.match(JSON.stringify(result), /Synthetic Starter/);
  } finally {
    await client.disconnect().catch(() => {});
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
