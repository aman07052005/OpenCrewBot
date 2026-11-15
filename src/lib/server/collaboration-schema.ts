import type { Client } from "@libsql/client";

/** Separate additive schema, safe to re-run without touching Module D's migrations. */
export async function migrateCollaborationSchema(client: Client): Promise<void> {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS collaboration_sessions (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, objective TEXT NOT NULL,
      member_ids TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('mock','live')),
      plan_json TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS collaboration_rounds (
      session_id TEXT NOT NULL REFERENCES collaboration_sessions(id), ordinal INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('work','requests','review','final','continuation')),
      run_id TEXT NOT NULL UNIQUE REFERENCES execution_runs(id), instruction TEXT NOT NULL,
      PRIMARY KEY(session_id, ordinal)
    )`,
    `CREATE TABLE IF NOT EXISTS collaboration_automation (
      session_id TEXT PRIMARY KEY REFERENCES collaboration_sessions(id),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS collaboration_revision_locks (
      session_id TEXT PRIMARY KEY REFERENCES collaboration_sessions(id),
      token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS collaboration_revision_submissions (
      session_id TEXT NOT NULL REFERENCES collaboration_sessions(id), token TEXT NOT NULL,
      submitted_at TEXT NOT NULL, PRIMARY KEY(session_id, token)
    )`,
    "CREATE INDEX IF NOT EXISTS collaboration_by_room ON collaboration_sessions(room_id, created_at DESC)",
    `CREATE TRIGGER IF NOT EXISTS collaboration_closed_guard BEFORE INSERT ON collaboration_rounds
      WHEN EXISTS (SELECT 1 FROM collaboration_sessions WHERE id=NEW.session_id AND closed_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'Collaboration session is closed'); END`,
    `CREATE TRIGGER IF NOT EXISTS collaboration_revision_submission_guard BEFORE INSERT ON collaboration_revision_submissions
      WHEN NOT EXISTS (SELECT 1 FROM collaboration_revision_locks WHERE session_id=NEW.session_id AND token=NEW.token)
      BEGIN SELECT RAISE(ABORT, 'Collaboration revision is stale or no longer active'); END`,
    `CREATE TRIGGER IF NOT EXISTS collaboration_revision_submission_consumes_lock AFTER INSERT ON collaboration_revision_submissions
      BEGIN DELETE FROM collaboration_revision_locks WHERE session_id=NEW.session_id AND token=NEW.token; END`,
  ], "write");
}
