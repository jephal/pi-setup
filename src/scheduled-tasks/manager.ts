import { nextCronOccurrence, localOccurrenceKey } from "./cron.ts";
import {
  DISPATCH_RETRY_DELAY_MS,
  MAX_PROMPT_LENGTH,
  MAX_SCHEDULED_TASKS,
  type ScheduledTask,
  type ScheduleSpec,
} from "./types.ts";

export type SchedulerClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

export type SchedulerRuntime = {
  isIdle: () => boolean;
  sendPrompt: (prompt: string, delivery: "normal" | "followUp") => Promise<void>;
  notify?: (message: string, type: "info" | "warning" | "error") => void;
};

export type SchedulerPersistence = {
  list: () => ScheduledTask[];
  save: (task: ScheduledTask) => void;
  delete: (id: string) => boolean;
  close?: () => void;
};

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

function cloneTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    schedule: { ...task.schedule },
  };
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function validTask(task: ScheduledTask): boolean {
  return Boolean(
    task.id && task.name && task.prompt && task.createdAt && task.schedule
    && (task.schedule.kind === "once" || task.schedule.kind === "cron")
    && typeof task.recurring === "boolean"
    && typeof task.pending === "boolean",
  );
}

export class ScheduledTaskManager {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly clock: SchedulerClock;
  private readonly persistence: SchedulerPersistence;
  private runtime: SchedulerRuntime | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dispatchPromise: Promise<void> | undefined;
  private dispatching = new Set<string>();
  private running = false;

  constructor(persistence: SchedulerPersistence, clock: SchedulerClock = realClock) {
    this.persistence = persistence;
    this.clock = clock;
    for (const task of persistence.list()) {
      if (validTask(task)) this.tasks.set(task.id, cloneTask(task));
    }
  }

  start(runtime: SchedulerRuntime): void {
    this.runtime = runtime;
    this.running = true;
    this.armTimer();
  }

  stop(): void {
    this.running = false;
    this.runtime = undefined;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  async close(): Promise<void> {
    this.stop();
    await this.dispatchPromise?.catch(() => undefined);
    this.persistence.close?.();
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].map(cloneTask);
  }

  create(input: {
    name?: string;
    prompt: string;
    schedule: string;
    runAt?: string;
    timezone?: string;
  }): ScheduledTask {
    if (this.tasks.size >= MAX_SCHEDULED_TASKS) {
      throw new Error(`Maximum of ${MAX_SCHEDULED_TASKS} scheduled tasks reached.`);
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("A scheduled task prompt is required.");
    if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt exceeds ${MAX_PROMPT_LENGTH} characters.`);

    const schedule = this.parseInputSchedule(input);
    const now = this.clock.now();
    const task: ScheduledTask = {
      id: `st-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`,
      name: input.name?.trim() || prompt.split(/\s+/).slice(0, 5).join(" "),
      prompt,
      schedule,
      recurring: schedule.kind === "cron",
      createdAt: iso(now),
      nextRunAt: schedule.kind === "once" ? schedule.at : iso(nextCronOccurrence(schedule.expression, schedule.timezone, new Date(now)).getTime()),
      pending: false,
    };
    this.tasks.set(task.id, task);
    this.persist(task);
    this.armTimer();
    return cloneTask(task);
  }

  delete(id: string): boolean {
    let task: ScheduledTask;
    try {
      task = this.resolve(id);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Scheduled task not found:")) return false;
      throw error;
    }
    this.tasks.delete(task.id);
    this.persistence.delete(task.id);
    this.armTimer();
    return true;
  }

  runNow(id: string): ScheduledTask {
    const task = this.resolve(id);
    task.pending = true;
    task.retryAt = iso(this.clock.now());
    task.lastError = undefined;
    this.persist(task);
    void this.dispatchPending();
    return cloneTask(task);
  }

  /** Execute due work. Exposed so tests can drive time without waiting. */
  async tick(now = this.clock.now()): Promise<void> {
    if (!this.running) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;

    for (const task of this.tasks.values()) {
      const next = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.POSITIVE_INFINITY;
      const retry = task.retryAt ? Date.parse(task.retryAt) : Number.POSITIVE_INFINITY;
      if (task.pending ? retry <= now : next <= now) {
        if (!task.pending) this.markDue(task, now);
      }
    }
    this.persistAllPending();
    await this.dispatchPending();
    this.armTimer();
  }

  private parseInputSchedule(input: { schedule: string; runAt?: string; timezone?: string }): ScheduleSpec {
    const expression = input.schedule.trim();
    if (expression.toLowerCase() === "once") {
      if (!input.runAt) throw new Error('One-shot tasks require "runAt" as an ISO timestamp.');
      const timestamp = Date.parse(input.runAt);
      if (!Number.isFinite(timestamp)) throw new Error(`Invalid runAt timestamp: ${input.runAt}`);
      if (timestamp <= this.clock.now()) throw new Error("runAt must be in the future.");
      return { kind: "once", at: new Date(timestamp).toISOString() };
    }
    if (!input.timezone?.trim()) throw new Error("Recurring tasks require an IANA timezone.");
    // nextCronOccurrence validates both the expression and timezone.
    nextCronOccurrence(expression, input.timezone.trim(), new Date(this.clock.now()));
    return { kind: "cron", expression, timezone: input.timezone.trim() };
  }

  private markDue(task: ScheduledTask, now: number): void {
    task.pending = true;
    task.retryAt = iso(now);
    task.lastError = undefined;
    if (task.schedule.kind === "cron" && task.nextRunAt) {
      const scheduledAt = new Date(task.nextRunAt);
      task.nextRunAt = iso(nextCronOccurrence(
        task.schedule.expression,
        task.schedule.timezone,
        scheduledAt,
        localOccurrenceKey(scheduledAt, task.schedule.timezone),
      ).getTime());
    } else {
      task.nextRunAt = undefined;
    }
  }

  private async dispatchPending(): Promise<void> {
    if (this.dispatchPromise || !this.running || !this.runtime) return;
    this.dispatchPromise = this.dispatchPendingInternal().finally(() => {
      this.dispatchPromise = undefined;
      if (this.running) this.armTimer();
    });
    await this.dispatchPromise;
  }

  private async dispatchPendingInternal(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    for (const task of this.tasks.values()) {
      if (!this.running || this.runtime !== runtime) return;
      if (!task.pending || this.dispatching.has(task.id)) continue;
      this.dispatching.add(task.id);
      try {
        await runtime.sendPrompt(task.prompt, runtime.isIdle() ? "normal" : "followUp");
        task.pending = false;
        task.retryAt = undefined;
        task.lastRunAt = iso(this.clock.now());
        task.lastError = undefined;
        if (task.schedule.kind === "once") {
          this.tasks.delete(task.id);
          this.persistence.delete(task.id);
        } else {
          this.persist(task);
        }
        runtime.notify?.(`Scheduled task completed: ${task.name}`, "info");
      } catch (error) {
        task.retryAt = iso(this.clock.now() + DISPATCH_RETRY_DELAY_MS);
        task.lastError = error instanceof Error ? error.message : String(error);
        this.persist(task);
        runtime.notify?.(`Scheduled task will retry: ${task.name}`, "warning");
      } finally {
        this.dispatching.delete(task.id);
      }
    }
  }

  private resolve(id: string): ScheduledTask {
    const exact = this.tasks.get(id);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(id));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Task ID is ambiguous: ${id}`);
    throw new Error(`Scheduled task not found: ${id}`);
  }

  private persist(task: ScheduledTask): void {
    this.persistence.save(cloneTask(task));
  }

  private persistAllPending(): void {
    for (const task of this.tasks.values()) if (task.pending) this.persist(task);
  }

  private armTimer(): void {
    if (!this.running) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    const now = this.clock.now();
    const allDeadlines = [...this.tasks.values()]
      .flatMap((task) => [task.pending && task.retryAt ? Date.parse(task.retryAt) : Number.POSITIVE_INFINITY, task.nextRunAt ? Date.parse(task.nextRunAt) : Number.POSITIVE_INFINITY])
      .filter((deadline) => Number.isFinite(deadline));
    if (allDeadlines.some((deadline) => deadline <= now)) {
      this.timer = this.clock.setTimeout(() => void this.tick(), 1);
      return;
    }
    const deadlines = allDeadlines.filter((deadline) => deadline > now);
    if (deadlines.length === 0) {
      if (this.tasks.size === 0) return;
      this.timer = this.clock.setTimeout(() => void this.tick(), DISPATCH_RETRY_DELAY_MS);
      return;
    }
    const delay = Math.max(1, Math.min(Math.min(...deadlines) - now, 2_147_000_000));
    this.timer = this.clock.setTimeout(() => void this.tick(), delay);
  }
}
