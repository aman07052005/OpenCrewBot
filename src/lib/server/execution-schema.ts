import type { Client } from "@libsql/client";

/** Additive Module D migration. Existing OpenCrewBot tables are untouched. */
export async function migrateExecutionSchema(client: Client): Promise<void> {
  await client.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = await client.execute("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations");
  const version = Number(current.rows[0]?.version ?? 0);
  if (version < 1) {
    await client.batch(
      [
      `CREATE TABLE IF NOT EXISTS execution_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','blocked','completed','failed','cancelled')),
        concurrency_limit INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS execution_tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','blocked','running','succeeded','failed','cancelled','skipped')),
        requires_approval INTEGER NOT NULL DEFAULT 0,
        approved_at TEXT,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        claim_token TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (run_id) REFERENCES execution_runs(id)
      )`,
      `CREATE TABLE IF NOT EXISTS execution_task_dependencies (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id),
        FOREIGN KEY (run_id) REFERENCES execution_runs(id),
        FOREIGN KEY (task_id) REFERENCES execution_tasks(id),
        FOREIGN KEY (depends_on_task_id) REFERENCES execution_tasks(id)
      )`,
      "CREATE INDEX IF NOT EXISTS execution_runs_by_created ON execution_runs (created_at DESC)",
      "CREATE INDEX IF NOT EXISTS execution_tasks_by_run_status ON execution_tasks (run_id, status, created_at)",
      "CREATE INDEX IF NOT EXISTS execution_dependencies_by_parent ON execution_task_dependencies (depends_on_task_id)",
        { sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?) ON CONFLICT(version) DO NOTHING", args: [new Date().toISOString()] },
      ],
      "write",
    );
  }

  const afterBase = await client.execute("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations");
  if (Number(afterBase.rows[0]?.version ?? 0) < 2) {
    await client.batch(
      [
        "ALTER TABLE execution_runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'mock' CHECK (execution_mode IN ('mock','live'))",
        { sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?) ON CONFLICT(version) DO NOTHING", args: [new Date().toISOString()] },
      ],
      "write",
    );
  }
}
