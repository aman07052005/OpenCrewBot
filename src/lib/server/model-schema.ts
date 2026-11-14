import type { Client } from "@libsql/client";

/** Additive Module J usage ledger. Provider credentials are never persisted. */
export async function migrateModelSchema(client: Client): Promise<void> {
  await client.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = await client.execute("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations");
  if (Number(current.rows[0]?.version ?? 0) < 7) await client.batch([
    `CREATE TABLE IF NOT EXISTS model_usage_records (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT, execution_run_id TEXT, task_id TEXT,
      provider_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      usage_kind TEXT NOT NULL CHECK(usage_kind IN ('reported','estimated','unknown','simulated')),
      duration_ms INTEGER, success INTEGER NOT NULL, fallback_attempt INTEGER NOT NULL,
      estimated_cost_usd REAL, currency TEXT NOT NULL, pricing_version TEXT, routing_reason TEXT NOT NULL,
      error TEXT, created_at TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS model_usage_by_created ON model_usage_records(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS model_usage_by_agent ON model_usage_records(agent_id,created_at DESC)",
    { sql: "INSERT INTO schema_migrations(version,applied_at) VALUES(7,?) ON CONFLICT(version) DO NOTHING", args: [new Date().toISOString()] },
  ], "write");
  const after = await client.execute("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations");
  if (Number(after.rows[0]?.version ?? 0) < 8) await client.batch([
    "ALTER TABLE model_usage_records ADD COLUMN cached_input_tokens INTEGER",
    "ALTER TABLE model_usage_records ADD COLUMN reasoning_tokens INTEGER",
    { sql: "INSERT INTO schema_migrations(version,applied_at) VALUES(8,?) ON CONFLICT(version) DO NOTHING", args: [new Date().toISOString()] },
  ], "write");
}
