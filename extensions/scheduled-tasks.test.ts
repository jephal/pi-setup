import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextCronOccurrence } from "../src/scheduled-tasks/cron.ts";
import { ScheduledTaskManager, type SchedulerClock } from "../src/scheduled-tasks/manager.ts";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store.ts";
import type { ScheduledTask } from "../src/scheduled-tasks/types.ts";

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
