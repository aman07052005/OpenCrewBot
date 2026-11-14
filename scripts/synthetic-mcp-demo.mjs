import http from "node:http";
import { MCPServer } from "@mastra/mcp";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// A deliberately small local-only demonstration service. Its records are
// synthetic and the two tools are side-effect free; it has no credentials,
// filesystem access, subprocess access, or external network access.
const products = {
  "DEMO-100": { sku: "DEMO-100", name: "Synthetic Starter", unitPrice: 120, unitCost: 45, inventory: 72 },
  "DEMO-200": { sku: "DEMO-200", name: "Synthetic Growth", unitPrice: 260, unitCost: 95, inventory: 31 },
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tools = {
  get_synthetic_product: createTool({
    id: "get_synthetic_product",
    description: "Retrieve one synthetic product record for the local MCP demonstration.",
    mcp: { annotations: readOnly },
    inputSchema: z.object({ sku: z.enum(["DEMO-100", "DEMO-200"]) }),
    execute: async ({ sku }) => ({ synthetic: true, product: products[sku] }),
  }),
  calculate_synthetic_margin: createTool({
    id: "calculate_synthetic_margin",
    description: "Calculate a side-effect-free margin for synthetic demonstration values.",
    mcp: { annotations: readOnly },
    inputSchema: z.object({ revenue: z.number().nonnegative().max(1_000_000), cost: z.number().nonnegative().max(1_000_000) }),
    execute: async ({ revenue, cost }) => ({ synthetic: true, revenue, cost, grossProfit: revenue - cost, grossMargin: revenue ? (revenue - cost) / revenue : null }),
  }),
};

const mcp = new MCPServer({ id: "synthetic-business-data", name: "Synthetic business data", version: "1.0.0", tools });
const port = Number(process.env.OPENCREWBOT_MCP_DEMO_PORT ?? 3021);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("OPENCREWBOT_MCP_DEMO_PORT must be an unprivileged TCP port.");
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname !== "/mcp") { res.writeHead(404).end("Synthetic MCP demo is available at /mcp"); return; }
  await mcp.startHTTP({ url, httpPath: "/mcp", req, res });
});

server.listen(port, "127.0.0.1", () => console.log(`Synthetic MCP demo listening at http://127.0.0.1:${port}/mcp`));
const close = async () => { server.close(); await mcp.close(); };
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
