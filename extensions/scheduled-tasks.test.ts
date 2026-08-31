import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextCronOccurrence } from "../src/scheduled-tasks/cron.ts";
import { ScheduledTaskManager, type SchedulerClock } from "../src/scheduled-tasks/manager.ts";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store.ts";
import type { ScheduledTask } from "../src/scheduled-tasks/types.ts";
import scheduledTasksExtension, { activateScheduledTaskTools, deactivateScheduledTaskTools } from "./scheduled-tasks.ts";

type MemoryPersistence = {
  rows: Map<string, ScheduledTask>;
  list: () => ScheduledTask[];
  save: (task: ScheduledTask) => void;
  delete: (id: string) => boolean;
};

function memoryPersistence(): MemoryPersistence {
  const rows = new Map<string, ScheduledTask>();
  return {
    rows,
    list: () => [...rows.values()],
    save: (task) => rows.set(task.id, structuredClone(task)),
    delete: (id) => rows.delete(id),
  };
}

function fakeClock(initial: number): SchedulerClock & { advance: (value: number) => void } {
  let current = initial;
  return {
    now: () => current,
    advance: (value) => { current = value; },
    setTimeout: (callback, _delayMs) => {
      const timer = setTimeout(callback, 60_000);
      timer.unref();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

test("package loads optional tool-group resetters before approval policy snapshots", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { pi: { extensions: string[] } };
  const approvalIndex = manifest.pi.extensions.indexOf("extensions/approval-modes.ts");
  assert.ok(manifest.pi.extensions.indexOf("extensions/scheduled-tasks.ts") < approvalIndex);
  assert.ok(manifest.pi.extensions.indexOf("extensions/notes.ts") < approvalIndex);
});

test("scheduler loader keeps operations optional and avoids repeated active-tools churn", () => {
  const definitions: Array<{ name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] }> = [];
  let activeTools = ["read", "scheduled_task_tools"];
  let setCalls = 0;
  scheduledTasksExtension({
    on() {},
    registerCommand() {},
    registerTool(definition: { name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] }) { definitions.push(definition); },
    getActiveTools: () => activeTools,
    setActiveTools(next: string[]) { setCalls++; activeTools = next; },
  } as any);

  const loader = definitions.find((definition) => definition.name === "scheduled_task_tools");
  const create = definitions.find((definition) => definition.name === "scheduled_task_create");
  assert.ok(loader);
  assert.ok(create);
  assert.match(loader.description, /only when the user asks/);
  assert.match(loader.promptGuidelines!.join("\n"), /five-field cron/);
  assert.match(create.description, /never send the user to a scheduler command/);
  assert.equal(create.promptSnippet, undefined);

  let staleTools = [...activeTools, "scheduled_task_create", "scheduled_task_list", "scheduled_task_delete", "scheduled_task_run_now"];
  let resetCalls = 0;
  deactivateScheduledTaskTools({
    getActiveTools: () => staleTools,
    setActiveTools(next) { resetCalls++; staleTools = next; },
  } as any);
  assert.deepEqual(staleTools, ["read", "scheduled_task_tools"]);
  deactivateScheduledTaskTools({
    getActiveTools: () => staleTools,
    setActiveTools(next) { resetCalls++; staleTools = next; },
  } as any);
  assert.equal(resetCalls, 1);

  assert.deepEqual(activateScheduledTaskTools({
    getActiveTools: () => activeTools,
    setActiveTools(next) { setCalls++; activeTools = next; },
  } as any), ["scheduled_task_create", "scheduled_task_list", "scheduled_task_delete", "scheduled_task_run_now"]);
  assert.equal(setCalls, 1);
  assert.deepEqual(activateScheduledTaskTools({
    getActiveTools: () => activeTools,
    setActiveTools(next) { setCalls++; activeTools = next; },
  } as any), []);
  assert.equal(setCalls, 1);
});

test("computes recurring cron occurrences in an explicit timezone", () => {
  const after = new Date("2026-08-26T06:01:00.000Z");
  const next = nextCronOccurrence("0 9 * * 1-5", "Europe/Copenhagen", after);
  assert.equal(next.toISOString(), "2026-08-26T07:00:00.000Z");
});

test("skips a nonexistent spring-forward wall-clock time", () => {
  const after = new Date("2026-03-28T12:00:00.000Z");
  const next = nextCronOccurrence("30 2 * * *", "Europe/Copenhagen", after);
  assert.equal(next.toISOString(), "2026-03-30T00:30:00.000Z");
});

test("dispatches a one-shot task and removes it after acceptance", async () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");
  const clock = fakeClock(now);
  const persistence = memoryPersistence();
  const deliveries: Array<{ prompt: string; delivery: string }> = [];
  const manager = new ScheduledTaskManager(persistence, clock);
  const task = manager.create({
    name: "Smoke reminder",
    prompt: "Check the build",
    schedule: "once",
    runAt: "2026-08-26T12:01:00.000Z",
  });

  manager.start({
    isIdle: () => true,
    sendPrompt: async (prompt, delivery) => { deliveries.push({ prompt, delivery }); },
  });
  clock.advance(Date.parse(task.nextRunAt!));
  await manager.tick();

  assert.deepEqual(deliveries, [{ prompt: "Check the build", delivery: "normal" }]);
  assert.equal(manager.list().length, 0);
  await manager.close();
});

test("coalesces due recurring work and queues it behind a busy turn", async () => {
  const now = Date.parse("2026-08-26T12:00:01.000Z");
  const clock = fakeClock(now);
  const persistence = memoryPersistence();
  const deliveries: string[] = [];
  const manager = new ScheduledTaskManager(persistence, clock);
  const task = manager.create({
    prompt: "Check CI",
    schedule: "*/5 * * * *",
    timezone: "Europe/Copenhagen",
  });

  manager.start({
    isIdle: () => false,
    sendPrompt: async (_prompt, delivery) => { deliveries.push(delivery); },
  });
  clock.advance(Date.parse(task.nextRunAt!) + 60_000);
  await manager.tick();

  assert.deepEqual(deliveries, ["followUp"]);
  assert.equal(manager.list()[0].pending, false);
  assert.ok(Date.parse(manager.list()[0].nextRunAt!) > clock.now());
  await manager.close();
});

test("retries a failed dispatch without losing the task", async () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");
  const clock = fakeClock(now);
  const persistence = memoryPersistence();
  let attempts = 0;
  const manager = new ScheduledTaskManager(persistence, clock);
  const task = manager.create({
    prompt: "Retry this",
    schedule: "once",
    runAt: "2026-08-26T12:01:00.000Z",
  });

  manager.start({
    isIdle: () => true,
    sendPrompt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Pi is busy");
    },
  });
  clock.advance(Date.parse(task.nextRunAt!));
  await manager.tick();
  assert.equal(manager.list()[0].pending, true);
  assert.equal(manager.list()[0].lastError, "Pi is busy");

  clock.advance(Date.parse(manager.list()[0].retryAt!));
  await manager.tick();
  assert.equal(attempts, 2);
  assert.equal(manager.list().length, 0);
  await manager.close();
});

test("SQLite persistence is isolated by session and cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-scheduled-tasks-"));
  const path = join(directory, "tasks.sqlite");
  try {
    const first = new ScheduledTaskStore(path, "session-a", "/project-a");
    const task: ScheduledTask = {
      id: "st-test",
      name: "Persisted",
      prompt: "Do work",
      schedule: { kind: "once", at: "2026-08-26T12:01:00.000Z" },
      recurring: false,
      createdAt: "2026-08-26T12:00:00.000Z",
      nextRunAt: "2026-08-26T12:01:00.000Z",
      pending: false,
    };
    first.save(task);
    first.close();

    const sameScope = new ScheduledTaskStore(path, "session-a", "/project-a");
    assert.equal(sameScope.list()[0].prompt, "Do work");
    sameScope.close();

    const otherScope = new ScheduledTaskStore(path, "session-b", "/project-a");
    assert.deepEqual(otherScope.list(), []);
    otherScope.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
