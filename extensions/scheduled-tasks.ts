import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ScheduledTaskManager } from "../src/scheduled-tasks/manager.ts";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ScheduledTask } from "../src/scheduled-tasks/types.ts";

const databasePath = () => join(getAgentDir(), "scheduled-tasks", "tasks.sqlite");
const SCHEDULED_TASK_LOADER = "scheduled_task_tools";
const SCHEDULED_TASK_TOOLS = [
  "scheduled_task_create",
  "scheduled_task_list",
  "scheduled_task_delete",
  "scheduled_task_run_now",
] as const;

/** Adds the optional scheduler group without rewriting activeTools when it is already loaded. */
export function activateScheduledTaskTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): string[] {
  const activeTools = pi.getActiveTools();
  const addedTools = SCHEDULED_TASK_TOOLS.filter((name) => !activeTools.includes(name));
  if (addedTools.length > 0) pi.setActiveTools([...activeTools, ...addedTools]);
  return addedTools;
}

export function deactivateScheduledTaskTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
  const activeTools = pi.getActiveTools();
  const reducedTools = activeTools.filter((name) => !SCHEDULED_TASK_TOOLS.includes(name as typeof SCHEDULED_TASK_TOOLS[number]));
  if (reducedTools.length !== activeTools.length) pi.setActiveTools(reducedTools);
}

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
    deactivateScheduledTaskTools(pi);
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
    name: SCHEDULED_TASK_LOADER,
    label: "Activate Scheduled Tasks",
    description: "Activate scheduling operations only when the user asks for a reminder, recurring check, or future work.",
    promptSnippet: "Activate scheduled-task operations when scheduling work is requested",
    promptGuidelines: [
      "For recurring schedules, use five-field cron and preserve the requested IANA timezone.",
      "For one-shot work, use schedule='once' with an ISO runAt timestamp and explicit offset when possible.",
      "Scheduled prompts inherit this session's model, tools, MCP connections, working directory, and approval mode.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const addedTools = activateScheduledTaskTools(pi);
      return {
        content: [{ type: "text", text: addedTools.length ? `Activated scheduled-task operations: ${addedTools.join(", ")}.` : "Scheduled-task operations are already active." }],
        details: { addedTools },
      };
    },
  });

  pi.registerTool({
    name: "scheduled_task_create",
    label: "Create Scheduled Task",
    description: "Create a recurring or one-shot prompt Pi runs automatically; never send the user to a scheduler command.",
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
    description: "List scheduled prompts for the current session and project.",
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
    description: "Cancel a scheduled prompt by ID or unambiguous prefix.",
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
