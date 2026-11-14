import { keys } from "./config";
import { activeGmailAccount } from "./composio";
import { gmailVerificationKey } from "./gmail-service";
import { listServers } from "./mcp-servers";
import { integrationVerification } from "./integration-status";

export type IntegrationStatus = "not-configured" | "configured-unverified" | "connected-verified" | "connection-failed" | "simulated";
export interface IntegrationRecord {
  id: "github" | "gmail" | "mcp";
  name: string;
  status: IntegrationStatus;
  operations: string[];
  authentication: string;
  requiredPermissions: string;
  executionModes: string[];
  resourceScope: string;
  lastError?: string;
  verifiedAt?: string;
}
export async function integrationRegistry(): Promise<IntegrationRecord[]> {
  const githubVerification = await integrationVerification("github");
  let gmail: IntegrationRecord = {
    id: "gmail", name: "Gmail", status: keys.composio() ? "configured-unverified" : "not-configured",
    operations: ["Authenticated Gmail profile check", "Approved synthetic test-message retrieval", "local email draft preparation"], authentication: "Composio OAuth", requiredPermissions: "One owner-authorized test mailbox and explicit approval for message retrieval", executionModes: ["live", "local"], resourceScope: "One designated synthetic inbox message only; no sending, drafts or mailbox changes.",
  };
  if (keys.composio()) {
    try {
      const account = await activeGmailAccount();
      if (account) {
        const verified = await integrationVerification(gmailVerificationKey(account.id));
        gmail = { ...gmail, status: verified.lastError ? "connection-failed" : verified.lastSuccessfulAt ? "connected-verified" : "configured-unverified", verifiedAt: verified.lastSuccessfulAt, lastError: verified.lastError };
      }
    } catch {
      gmail = { ...gmail, status: "connection-failed", lastError: "Gmail account lookup failed. Use one authorized test mailbox." };
    }
  }
  const servers = await listServers();
  const mcpVerifications = await Promise.all(servers.map((server) => integrationVerification(`mcp:${server.id}`)));
  const lastMcpSuccess = mcpVerifications.map((entry) => entry.lastSuccessfulAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const lastMcpError = mcpVerifications.map((entry) => entry.lastError).filter((value): value is string => Boolean(value)).at(-1);
  return [
    {
      id: "github", name: "GitHub", status: githubVerification.lastSuccessfulAt ? "connected-verified" : githubVerification.lastError ? "connection-failed" : "configured-unverified",
      operations: ["repository metadata", "directory listing", "selected file retrieval", "issue inspection", "pull request inspection"], authentication: "Public GitHub REST API", requiredPermissions: "Explicit repository identifier and selected agent", executionModes: ["live"], resourceScope: "Public repositories only; a request names one repository and optional ref/path.", lastError: githubVerification.lastError, verifiedAt: githubVerification.lastSuccessfulAt,
    },
    gmail,
    {
      id: "mcp", name: "MCP", status: !servers.length ? "not-configured" : lastMcpSuccess ? "connected-verified" : lastMcpError ? "connection-failed" : "configured-unverified",
      operations: ["server connection test", "tool discovery", "tool schema inspection", "owner-enabled read-only tool invocation"], authentication: "Stored MCP server token or headers", requiredPermissions: "Explicit server, bot connection, and owner-enabled read-only tool", executionModes: ["live"], resourceScope: "Only configured server IDs and currently advertised read-only tools.", lastError: lastMcpError, verifiedAt: lastMcpSuccess,
    },
  ];
}
