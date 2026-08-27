import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ScheduledTask, ScheduleSpec } from "./types.ts";

 type Row = Record<string, unknown>;

function parseSchedule(value: unknown): ScheduleSpec | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const schedule = JSON.parse(value) as unknown;
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return undefined;
    const record = schedule as Record<string, unknown>;
    if (record.kind === "once" && typeof record.at === "string") return { kind: "once", at: record.at };
    if (record.kind === "cron" && typeof record.expression === "string" && typeof record.timezone === "string") {
      return { kind: "cron", expression: record.expression, timezone: record.timezone };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toTask(row: Row): ScheduledTask | undefined {
  const schedule = parseSchedule(row.schedule_json);
  if (!schedule || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.prompt !== "string") return undefined;
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule,
    recurring: Number(row.recurring ?? 0) === 1,
    createdAt: String(row.created_at),
    nextRunAt: typeof row.next_run_at === "string" ? row.next_run_at : undefined,
    lastRunAt: typeof row.last_run_at === "string" ? row.last_run_at : undefined,
    pending: Number(row.pending ?? 0) === 1,
    retryAt: typeof row.retry_at === "string" ? row.retry_at : undefined,
    lastError: typeof row.last_error === "string" ? row.last_error : undefined,
  };
}

export class ScheduledTaskStore {
  private readonly db: DatabaseSync;
  private readonly sessionId: string;
  private readonly cwd: string;

  constructor(databasePath: string, sessionId: string, cwd: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 2500; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        recurring INTEGER NOT NULL CHECK (recurring IN (0, 1)),
        created_at TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
        retry_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, cwd, id)
      );
      CREATE INDEX IF NOT EXISTS scheduled_tasks_scope_idx
        ON scheduled_tasks(session_id, cwd, updated_at);
    `);
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  list(): ScheduledTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE session_id = ? AND cwd = ?
      ORDER BY next_run_at IS NULL, next_run_at, created_at
    `).all(this.sessionId, this.cwd) as Row[];
    return rows.map(toTask).filter((task): task is ScheduledTask => task !== undefined);
  }

  save(task: ScheduledTask): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scheduled_tasks
        (id, session_id, cwd, name, prompt, schedule_json, recurring, created_at,
         next_run_at, last_run_at, pending, retry_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, cwd, id) DO UPDATE SET
        name = excluded.name,
        prompt = excluded.prompt,
        schedule_json = excluded.schedule_json,
        recurring = excluded.recurring,
        created_at = excluded.created_at,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        pending = excluded.pending,
        retry_at = excluded.retry_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      task.id,
      this.sessionId,
      this.cwd,
      task.name,
      task.prompt,
      JSON.stringify(task.schedule),
      task.recurring ? 1 : 0,
      task.createdAt,
      task.nextRunAt ?? null,
      task.lastRunAt ?? null,
      task.pending ? 1 : 0,
      task.retryAt ?? null,
      task.lastError ?? null,
      now,
    );
  }

  delete(id: string): boolean {
    return this.db.prepare(
      "DELETE FROM scheduled_tasks WHERE id = ? AND session_id = ? AND cwd = ?",
    ).run(id, this.sessionId, this.cwd).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
