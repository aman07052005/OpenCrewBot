import { randomUUID } from "node:crypto";
import type { Bot, BotInput } from "../shared/types.ts";

export interface BotCreationDependencies {
  listBots: () => Promise<Bot[]>;
  saveBot: (bot: Bot) => Promise<void>;
  writeMemory: (botId: string, content: string) => unknown | Promise<unknown>;
  publishBotsChanged: () => void;
  now?: () => Date;
  createId?: () => string;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "bot";
}

function uniqueHandle(wanted: string, bots: Bot[]): string {
  const taken = new Set(bots.map((bot) => bot.handle));
  const base = slug(wanted);
  let handle = base;
  for (let n = 2; taken.has(handle) || ["everyone", "all"].includes(handle); n++) handle = `${base}${n}`;
  return handle;
}

/** Shared persistence path for factory and manual bot creation. */
export async function createBotRecord(input: BotInput, dependencies: BotCreationDependencies): Promise<Bot> {
  const bots = await dependencies.listBots();
  const bot: Bot = {
    ...input,
    id: (dependencies.createId ?? (() => randomUUID().slice(0, 8)))(),
    name: input.name.trim(),
    connections: input.connections ?? [],
    handle: uniqueHandle(input.handle || input.name, bots),
    createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  await dependencies.saveBot(bot);
  await dependencies.writeMemory(bot.id, `# ${bot.name}'s memory\n\n`);
  dependencies.publishBotsChanged();
  return bot;
}
