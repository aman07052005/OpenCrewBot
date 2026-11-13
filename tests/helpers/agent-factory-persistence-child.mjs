import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createBotRecord } from "../../src/lib/server/bot-creation.ts";
import { createAgentFactoryService } from "../../src/lib/server/agent-factory-service.ts";

const [, , operation, dbUrl, memoryRoot] = process.argv;
const model = { id: "MiniMaxAI/MiniMax-M3", label: "MiniMax M3" };
const client = createClient({ url: dbUrl });

try {
  await client.execute("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  const listBots = async () => {
    const rows = await client.execute("SELECT data FROM bots");
    return rows.rows.map((row) => JSON.parse(String(row.data)));
  };
  const saveBot = async (bot) => {
    await client.execute({
      sql: "INSERT INTO bots (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      args: [bot.id, JSON.stringify(bot)],
    });
  };

  if (operation === "create") {
    const factory = createAgentFactoryService({
      listBots,
      listModels: async () => [model],
      defaultModel: model.id,
      hasLiveKey: () => false,
      createBot: (input) => createBotRecord(input, {
        listBots,
        saveBot,
        writeMemory: (botId, content) => {
          const directory = join(memoryRoot, botId);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "MEMORY.md"), content, "utf8");
        },
        publishBotsChanged: () => undefined,
      }),
    });
    const draft = await factory.generate({ description: "Create a financial analyst for forecasting.", generationMode: "mock" });
    draft.name = "Restart Analyst";
    draft.handle = "restart-analyst";
    const bot = await factory.save({ draft });
    process.stdout.write(`${JSON.stringify({ id: bot.id })}\n`);
  } else if (operation === "verify") {
    const bot = (await listBots())[0];
    if (!bot) throw new Error("No agent record survived the restart.");
    const memory = readFileSync(join(memoryRoot, bot.id, "MEMORY.md"), "utf8");
    process.stdout.write(`${JSON.stringify({ record: bot, memory })}\n`);
  } else {
    throw new Error(`Unknown persistence operation: ${operation}`);
  }
} finally {
  await client.close();
}
