import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ScheduledTaskManager } from "../src/scheduled-tasks/manager.ts";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ScheduledTask } from "../src/scheduled-tasks/types.ts";

const databasePath = () => join(getAgentDir(), "scheduled-tasks", "tasks.sqlite");

const createParameters = Type.Object({
  prompt: Type.String({ description: "The prompt to run when the schedule fires." }),
  schedule: Type.String({ description: "A five-field cron expression such as '0 9 * * 1-5', or 'once' for a one-shot task." }),
  runAt: Type.Optional(Type.String({ description: "Required for schedule='once'. ISO timestamp, for example 2026-08-27T09:00:00+02:00." })),
  timezone: Type.Optional(Type.String({ description: "Required for recurring tasks. IANA timezone such as Europe/Copenhagen." })),
  name: Type.Optional(Type.String({ description: "Short human-readable task name." })),
});

const idParameters = Type.Object({
  taskId: Type.String({ description: "The task ID, or an unambiguous ID prefix." }),
});

function formatTask(task: ScheduledTask): string {
  const schedule = task.schedule.kind === "once"
    ? `once at ${task.schedule.at}`
    : `${task.schedule.expression} (${task.schedule.timezone})`;
  const state = task.pending ? "pending" : "scheduled";
  return `${task.id} [${state}] ${task.name}\n  ${schedule}\n  next: ${task.nextRunAt ?? "after pending fire"}\n  prompt: ${task.prompt.slice(0, 160)}`;
}

function getManager(manager: ScheduledTaskManager | undefined): ScheduledTaskManager {
  if (!manager) throw new Error("Scheduled tasks are not available until the Pi session has started.");
  return manager;
}

export default function scheduledTasksExtension(pi: ExtensionAPI): void {
  let manager: ScheduledTaskManager | undefined;
  let context: ExtensionContext | undefined;

  pi.on("session_start", async (_event, ctx) => {
    await manager?.close();
    context = ctx;
    const store = new ScheduledTaskStore(databasePath(), ctx.sessionManager.getSessionId(), ctx.cwd);
    manager = new ScheduledTaskManager(store);
    if (ctx.mode === "print" || ctx.mode === "json") return;
    manager.start({
      isIdle: () => context?.isIdle() ?? false,
      sendPrompt: async (prompt, delivery) => {
        if (delivery === "normal") await pi.sendUserMessage(prompt);
        else await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      },
      notify: (message, type) => {
        if (context?.hasUI) context.ui.notify(message, type);
      },
    });
  });

  pi.on("session_shutdown", async () => {
    context = undefined;
    await manager?.close();
    manager = undefined;
  });

  pi.registerTool({
    name: "scheduled_task_create",
    label: "Create Scheduled Task",
    description: "Create a recurring or one-shot prompt that Pi runs automatically. Use this when the user asks to be reminded, to check something later, or to repeat a task. Do not tell the user to edit a file or run a scheduler command.",
    promptSnippet: "Create an agent-managed recurring or one-shot scheduled prompt",
    promptGuidelines: [
      "Use scheduled_task_create when the user asks for a reminder, a periodic check, or work at a future time.",
      "For recurring tasks, convert the requested local time into a five-field cron expression and pass the requested IANA timezone unchanged.",
      "For one-shot tasks, use schedule='once' and provide runAt as an ISO timestamp with an explicit offset when possible.",
      "Scheduled tasks inherit the current Pi session's model, tools, MCP connections, working directory, and approval mode.",
    ],
    parameters: createParameters,
    async execute(_toolCallId, params) {
      const task = getManager(manager).create(params);
      return {
        content: [{ type: "text", text: `Scheduled task created.\n${formatTask(task)}` }],
        details: { task },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", "Schedule task ") + theme.fg("muted", args.name ?? args.schedule), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const text = result.content.find((part) => part.type === "text")?.text ?? "Scheduled task created.";
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", text.split("\n", 1)[0] ?? text), 0, 0);
    },
  });

  pi.registerTool({
    name: "scheduled_task_list",
    label: "List Scheduled Tasks",
    description: "List scheduled prompts for the current Pi session and project.",
    promptSnippet: "List current scheduled prompts and their next run times",
    parameters: Type.Object({}),
    async execute() {
      const tasks = getManager(manager).list();
      return {
        content: [{ type: "text", text: tasks.length ? tasks.map(formatTask).join("\n\n") : "No scheduled tasks." }],
        details: { tasks },
      };
    },
  });

  pi.registerTool({
    name: "scheduled_task_delete",
    label: "Delete Scheduled Task",
    description: "Cancel a scheduled prompt by ID or unambiguous ID prefix.",
    promptSnippet: "Cancel a scheduled prompt",
    parameters: idParameters,
    async execute(_toolCallId, params) {
      const deleted = getManager(manager).delete(params.taskId);
      return {
        content: [{ type: "text", text: deleted ? `Deleted scheduled task ${params.taskId}.` : `Scheduled task ${params.taskId} was not found.` }],
        details: { deleted, taskId: params.taskId },
      };
    },
  });

  pi.registerTool({
    name: "scheduled_task_run_now",
    label: "Run Scheduled Task Now",
    description: "Queue a scheduled prompt immediately without changing its recurring schedule.",
    parameters: idParameters,
    async execute(_toolCallId, params) {
      const task = getManager(manager).runNow(params.taskId);
      return {
        content: [{ type: "text", text: `Queued scheduled task ${task.id} to run now.` }],
        details: { task },
      };
    },
  });

  pi.registerCommand("scheduled-tasks", {
    description: "List scheduled prompts for this session",
    handler: async (_args, ctx) => {
      const tasks = getManager(manager).list();
      ctx.ui.notify(tasks.length ? tasks.map(formatTask).join("\n\n") : "No scheduled tasks.", "info");
    },
  });
}
