import { body, handle } from "@/lib/server/http";
import { getBot } from "@/lib/server/db";
import { InputError } from "@/lib/server/errors";
import { GitHubRequestSchema, inspectGitHub } from "@/lib/server/github-integration";
import { recordIntegrationFailure, recordIntegrationSuccess } from "@/lib/server/integration-status";

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body<{ agentId?: string } & Record<string, unknown>>(request);
    const { agentId, ...operation } = input;
    const bot = agentId ? await getBot(agentId) : null;
    if (!bot || (!bot.tools.webSearch && !bot.connections.includes("composio:github"))) {
      throw new InputError("Select an agent authorized for GitHub read access.");
    }
    // The Module H GitHub surface is deliberately public, read-only REST only.
    // Do not attach a server credential here: private repository access needs a
    // separate, scoped connection flow before it can be safely supported.
    const validatedOperation = GitHubRequestSchema.parse(operation);
    try {
      const result = await inspectGitHub(validatedOperation);
      await recordIntegrationSuccess("github");
      return { result };
    } catch (error) {
      await recordIntegrationFailure("github", error);
      throw error;
    }
  });
}
