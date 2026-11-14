import { DEFAULT_MODEL, listModels } from "./models";
import { createBot } from "./service";
import { listBots } from "./db";
import { isMock } from "./config";
import { InputError } from "./errors";
import { redactSecrets } from "./memory-files";
import { createLiveAgentFactoryGenerator } from "./agent-factory-model";
import { createAgentFactoryService } from "./agent-factory-service";

const factory = createAgentFactoryService({
  listBots,
  createBot,
  listModels,
  defaultModel: DEFAULT_MODEL,
  hasLiveKey: () => !isMock(),
  liveGenerator: createLiveAgentFactoryGenerator(),
  redactSecrets,
});

async function asInputError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "The Agent Factory request was invalid.");
  }
}

export const generateFactoryAgent = (input: unknown) => asInputError(() => factory.generate(input));
export const createFactoryAgent = (input: unknown) => asInputError(() => factory.save(input));
export const installWorkforceTemplates = () => asInputError(() => factory.installTemplates());

