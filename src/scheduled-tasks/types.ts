export type CronSchedule = {
  kind: "cron";
  expression: string;
  timezone: string;
};

export type OnceSchedule = {
  kind: "once";
  at: string;
};

export type ScheduleSpec = CronSchedule | OnceSchedule;

export type ScheduledTask = {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  recurring: boolean;
  createdAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  pending: boolean;
  retryAt?: string;
  lastError?: string;
};

export type ScheduledTaskSummary = ScheduledTask;

export const SCHEDULED_TASKS_ENTRY_TYPE = "pi-scheduled-tasks";
export const MAX_SCHEDULED_TASKS = 50;
export const MAX_PROMPT_LENGTH = 25_000;
export const DISPATCH_RETRY_DELAY_MS = 60_000;
