import type { Client } from "@libsql/client";

/** Additive Module I schema. Occurrences are the durable idempotency boundary. */
export async function migrateSchedulerSchema(client: Client): Promise<void> {
  await client.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = await client.execute("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations");
  if (Number(current.rows[0]?.version ?? 0) < 6) {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS scheduled_workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, objective TEXT NOT NULL,
        plan_json TEXT NOT NULL, agent_ids_json TEXT NOT NULL, schedule_json TEXT NOT NULL, timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_executed_at TEXT, next_run_at TEXT,
        last_run_status TEXT, last_run_id TEXT, last_error TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS scheduled_workflows_due ON scheduled_workflows(status, next_run_at)",
      `CREATE TABLE IF NOT EXISTS scheduled_workflow_occurrences (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES scheduled_workflows(id),
        occurrence_key TEXT NOT NULL UNIQUE, trigger TEXT NOT NULL CHECK(trigger IN ('automatic','manual')),
        scheduled_for TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('claimed','creating','started','completed','failed','cancelled')),
        run_id TEXT UNIQUE REFERENCES execution_runs(id), created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS scheduled_occurrences_by_workflow ON scheduled_workflow_occurrences(workflow_id, created_at DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS scheduled_one_open_occurrence ON scheduled_workflow_occurrences(workflow_id) WHERE status IN ('claimed','creating','started')",
      "ALTER TABLE execution_runs ADD COLUMN scheduled_workflow_id TEXT REFERENCES scheduled_workflows(id)",
      "ALTER TABLE execution_runs ADD COLUMN schedule_trigger TEXT CHECK(schedule_trigger IS NULL OR schedule_trigger IN ('automatic','manual'))",
      "CREATE INDEX IF NOT EXISTS execution_runs_by_scheduled_workflow ON execution_runs(scheduled_workflow_id, created_at DESC)",
      { sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?) ON CONFLICT(version) DO NOTHING", args: [new Date().toISOString()] },
    ], "write");
  }
  // Kept outside the version guard so installations that received the first
  // Module I migration also gain the cross-process overlap boundary.
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS scheduled_one_open_occurrence ON scheduled_workflow_occurrences(workflow_id) WHERE status IN ('claimed','creating','started')");
}
