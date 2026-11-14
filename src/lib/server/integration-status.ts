import { getSetting, setSetting } from "./db";
import { redactIntegrationText } from "./integration-safety";

const KEY = "integrations.connection-status.v1";

export interface IntegrationVerification {
  lastSuccessfulAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

async function all(): Promise<Record<string, IntegrationVerification>> {
  return (await getSetting<Record<string, IntegrationVerification>>(KEY)) ?? {};
}

export async function integrationVerification(id: string): Promise<IntegrationVerification> {
  return (await all())[id] ?? {};
}

export async function recordIntegrationSuccess(id: string): Promise<void> {
  const entries = await all();
  await setSetting(KEY, { ...entries, [id]: { ...entries[id], lastSuccessfulAt: new Date().toISOString(), lastError: undefined, lastErrorAt: undefined } });
}

export async function recordIntegrationFailure(id: string, error: unknown): Promise<void> {
  const entries = await all();
  const message = redactIntegrationText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  await setSetting(KEY, { ...entries, [id]: { ...entries[id], lastError: message, lastErrorAt: new Date().toISOString() } });
}
