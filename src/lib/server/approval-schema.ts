import type { Client } from "@libsql/client";

/** Additive Module G schema; action records never alter existing task approvals. */
export async function migrateApprovalSchema(client: Client): Promise<void> {
  await client.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = await client.execute("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations");
  if (Number(current.rows[0]?.version ?? 0) < 4) {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS action_requests (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT, execution_run_id TEXT, execution_task_id TEXT,
        tool TEXT NOT NULL, operation TEXT NOT NULL, arguments_json TEXT NOT NULL, preview TEXT NOT NULL,
        permission_level TEXT NOT NULL CHECK(permission_level IN ('ask','controlled','full')),
        decision TEXT NOT NULL CHECK(decision IN ('allowed','approval-required','denied')),
        reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','executing','succeeded','failed','cancelled','expired')),
        created_at TEXT NOT NULL, expires_at TEXT, decided_at TEXT, result_json TEXT, error TEXT, simulated INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS action_requests_by_status ON action_requests(status, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS action_requests_by_agent ON action_requests(agent_id, created_at DESC)",
      `CREATE TABLE IF NOT EXISTS action_audit_log (id TEXT PRIMARY KEY, action_id TEXT NOT NULL, event TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(action_id) REFERENCES action_requests(id))`,
      "CREATE INDEX IF NOT EXISTS action_audit_by_action ON action_audit_log(action_id, created_at)",
      { sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?) ON CONFLICT(version) DO NOTHING", args: [new Date().toISOString()] },
    ], "write");
  }
  const after = await client.execute("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations");
  if (Number(after.rows[0]?.version ?? 0) < 5) {
    await client.batch([
      "ALTER TABLE action_requests ADD COLUMN invocation_count INTEGER NOT NULL DEFAULT 0",
      { sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?) ON CONFLICT(version) DO NOTHING", args: [new Date().toISOString()] },
    ], "write");
  }
}
