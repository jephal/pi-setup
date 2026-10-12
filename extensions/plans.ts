import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { createEditableOptionsComponent } from "../src/pi-ui/index.ts";
import { withHerdrBlock } from "./herdr-blocking.ts";
import { Type } from "typebox";
import { checklistMarkdown, parseChecklistMarkdown, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_PROMPT_GUIDELINES, PLAN_TOOL_PROMPT_SNIPPET, planUpdateNotice, taskListWidgetLines } from "./plan-text.ts";
import { clearedPlanBoardSnapshot, projectPlanBoard } from "./plan-board.ts";
import {
	clearPlan,
	loadPlan,
	savePlan,
	type PlanIdentity,
	type PlanStep,
	type StoredPlan,
} from "../src/plan-mode/storage.js";

const execFileAsync = promisify(execFile);
let currentMode = "approve";
let currentIdentity: PlanIdentity | undefined;
const PLAN_TOOL_MARKER = "__pi_plan_tool_registered__";
let activeExecutionPlan: StoredPlan | undefined;

async function git(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 });
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

async function identity(cwd: string): Promise<PlanIdentity> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
	const branch = await git(cwd, ["branch", "--show-current"]) || `detached-${(await git(cwd, ["rev-parse", "--short", "HEAD"])) ?? "unknown"}`;
	const repository = root.split("/").pop() || "project";
	return { repository, branch, worktree: cwd, root, sessionId: "unknown" };
}

async function sessionIdentity(ctx: ExtensionContext): Promise<PlanIdentity> {
	return { ...(await identity(ctx.cwd)), sessionId: ctx.sessionManager.getSessionId() };
}

function changedPlanScope(left: PlanIdentity | undefined, right: PlanIdentity): boolean {
	return !left || left.root !== right.root || left.branch !== right.branch || left.sessionId !== right.sessionId;
}

function parseSteps(input: unknown): PlanStep[] {
	if (!Array.isArray(input)) return [];
	return input.map((step, index) => {
		const value = step as Record<string, unknown>;
		return { id: Number(value.id ?? index + 1), title: String(value.title ?? `Task ${index + 1}`), status: String(value.status ?? "pending") };
	});
}

function isCompleted(step: PlanStep): boolean {
	return ["complete", "completed", "done"].includes(step.status.trim().toLowerCase());
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const value = message as { role?: unknown; content?: unknown };
	if (value.role !== "assistant") return "";
	if (typeof value.content === "string") return value.content;
	if (!Array.isArray(value.content)) return "";
	return value.content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function markCompletedCheckpoints(plan: StoredPlan, text: string): boolean {
	let changed = false;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const id = Number(match[1]);
		const step = plan.steps.find((candidate) => candidate.id === id);
		if (step && !isCompleted(step)) {
			step.status = "completed";
			changed = true;
		}
	}
	return changed;
}

function allCheckpointsComplete(plan: StoredPlan): boolean {
	return plan.steps.length > 0 && plan.steps.every(isCompleted);
}

function emitPlanBoardPlan(pi: ExtensionAPI, ctx: ExtensionContext, plan: StoredPlan | undefined): void {
	const snapshot = plan ? projectPlanBoard(plan) : clearedPlanBoardSnapshot(currentIdentity ? {
		name: "Plan Board", repository: currentIdentity.repository, branch: currentIdentity.branch, root: currentIdentity.root, sessionId: currentIdentity.sessionId,
	} : { name: "Plan Board", repository: "project", branch: "unknown", root: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
	pi.events.emit("plan-board:plan", { cwd: ctx.cwd, snapshot });
}

function updateCheckpointWidget(ctx: ExtensionContext, plan: StoredPlan | undefined): void {
	if (!ctx.hasUI) return;
	if (!plan || plan.steps.length === 0) {
		ctx.ui.setWidget("plan-checkpoints", undefined);
		return;
	}
	ctx.ui.setWidget("plan-checkpoints", taskListWidgetLines(plan.steps), { placement: "aboveEditor" });
}

function planReviewOptions() {
	return [
		{ key: "approve-auto", label: "Approve — start execution in Auto mode", description: "Leave strict Plan mode and continue without per-tool approval prompts.", editable: false },
		{ key: "approve-edits", label: "Approve — start execution with code-edit approvals", description: "Leave strict Plan mode while keeping bash calls gated.", editable: false },
		{ key: "edit-task-list", label: "Edit the task list", description: "Change only the numbered task list and review it again.", editable: false },
		{ key: "keep-planning", label: "Keep planning", description: "Remain read-only in Plan mode and continue the conversation.", editable: false },
	];
}

function queuePlanUpdateExplanation(pi: ExtensionAPI, previous: StoredPlan, next: StoredPlan): void {
	pi.sendMessage({
		customType: "plan-update-context",
		content: planUpdateNotice(previous, next),
		display: false,
		details: { previousName: previous.name, nextName: next.name },
	}, { deliverAs: "steer" });
}

export default function plans(pi: ExtensionAPI): void {
	const ownsPlanTool = (globalThis as Record<string, unknown>)[PLAN_TOOL_MARKER] !== "approval";
	pi.events.emit("plan-tool:available", { version: "0.0.1" });
	pi.events.on("approval-mode:changed", (data) => {
		if (data && typeof data === "object" && "mode" in data && typeof data.mode === "string") currentMode = data.mode;
	});

	// Register the plan tool once at extension startup. Mode changes only
	// change the active tool policy; they never add/remove this tool. If the
	// standalone approval package owns the fallback, it remains the owner.
	if (ownsPlanTool) {
	pi.registerTool({
		name: "plan",
		label: "Plan",
		description: PLAN_TOOL_DESCRIPTION,
		promptSnippet: PLAN_TOOL_PROMPT_SNIPPET,
		promptGuidelines: PLAN_TOOL_PROMPT_GUIDELINES,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("status"), Type.Literal("clear")]),
			name: Type.Optional(Type.String()),
			steps: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(Type.Integer()), title: Type.String({ description: "Short numbered task text to show in the above-editor task list" }), status: Type.Optional(Type.String()) }))),
		}),
		renderCall(params, _theme, _context) {
			const steps = parseSteps(params.steps);
			return new Markdown(steps.length ? checklistMarkdown(params.name?.trim() || "current-task-list", steps) : "Preparing task list…", 1, 0, getMarkdownTheme());
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = await sessionIdentity(ctx);
			currentIdentity = id;
			if (params.action === "status") {
				const plan = await loadPlan(id);
				const tasks = plan?.steps.length ? checklistMarkdown(plan.name, plan.steps) : "- No task steps saved";
				return { content: [{ type: "text", text: plan ? `Task list · ${plan.name}\n${tasks}` : "No task list for this branch." }], details: plan ?? {} };
			}
			if (params.action === "clear") {
				await clearPlan(id);
				activeExecutionPlan = undefined;
				updateCheckpointWidget(ctx, undefined);
				emitPlanBoardPlan(pi, ctx, undefined);
				return { content: [{ type: "text", text: `Cleared the active plan for ${id.branch}.` }], details: { cleared: true, branch: id.branch } };
			}
			const previous = await loadPlan(id);
			const steps = parseSteps(params.steps ?? previous?.steps);
			if (!steps.length) throw new Error("plan create/update requires at least one numbered task step.");
			const name = params.name?.trim() || previous?.name || "current-task-list";
			const plan: StoredPlan = {
				name,
				kind: "checklist",
				content: checklistMarkdown(name, steps),
				steps,
				identity: id,
				updatedAt: new Date().toISOString(),
				execution: currentMode === "plan" ? undefined : previous?.execution,
			};
			if (currentMode !== "plan" && currentMode !== "review" && !plan.execution?.active && plan.steps.length > 0) {
				plan.execution = { active: true, startedAt: new Date().toISOString() };
			}
			let filePath = await savePlan(plan);
			emitPlanBoardPlan(pi, ctx, plan);
			activeExecutionPlan = plan.execution?.active ? plan : undefined;
			updateCheckpointWidget(ctx, plan);
			if (currentMode === "plan" && ctx.hasUI) {
				for (;;) {
					const review = await withHerdrBlock(pi, "Waiting for task-list review", () => ctx.ui.custom<{ key: string } | null>(
						(tui, theme, _keybindings, done) => createEditableOptionsComponent(tui, theme, done, {
							title: `Review task list · ${plan.name}`,
							options: planReviewOptions(),
							initialFocus: "options",
						}),
					));
					if (!review) {
						if (params.action === "update" && previous) queuePlanUpdateExplanation(pi, previous, plan);
						return { content: [{ type: "text", text: `Task list saved to ${filePath}. Remain in Plan mode; execution is still gated.` }], details: { plan, cancelled: true, executionReady: false } };
					}
					if (review.key === "edit-task-list") {
						const edited = await withHerdrBlock(pi, "Waiting for task-list edits", () => ctx.ui.editor("Edit numbered task list", checklistMarkdown(plan.name, plan.steps)));
						if (edited?.trim()) {
							const editedSteps = parseChecklistMarkdown(edited);
						if (editedSteps.length) {
							plan.steps = editedSteps;
							plan.content = checklistMarkdown(plan.name, editedSteps);
							plan.updatedAt = new Date().toISOString();
							filePath = await savePlan(plan);
							emitPlanBoardPlan(pi, ctx, plan);
							updateCheckpointWidget(ctx, plan);
						} else {
							ctx.ui.notify("Keep at least one numbered task in the list.", "warning");
						}
					}
					continue;
				}
					if (review.key === "keep-planning") {
						if (params.action === "update" && previous) queuePlanUpdateExplanation(pi, previous, plan);
						return { content: [{ type: "text", text: `Task list saved to ${filePath}. Stay in Plan mode to continue the discussion.` }], details: { plan, executionReady: false } };
					}
					const nextMode = review.key === "approve-auto" ? "auto" : "approve";
					const modeLabel = nextMode === "auto" ? "Auto mode" : "code-edit approvals";
					const announcement = `Task list approved. Leaving Plan mode and starting execution with ${modeLabel}.`;
					plan.execution = plan.steps.length ? { active: true, startedAt: new Date().toISOString() } : undefined;
					activeExecutionPlan = plan.execution?.active ? plan : undefined;
					filePath = await savePlan(plan);
					emitPlanBoardPlan(pi, ctx, plan);
					updateCheckpointWidget(ctx, plan);
					ctx.ui.notify(announcement, "info");
					pi.events.emit("approval-mode:set", { mode: nextMode });
					if (params.action === "update" && previous) queuePlanUpdateExplanation(pi, previous, plan);
					return { content: [{ type: "text", text: `[PLAN MODE EXITED]\n${announcement}\nThe numbered task list is approved. Begin implementation now; do not continue planning.` }], details: { plan, choice: review.key, nextMode, executionReady: true, planModeExited: true } };
				}
			}
			if (params.action === "update" && previous) queuePlanUpdateExplanation(pi, previous, plan);
			const executionReady = currentMode !== "review" && currentMode !== "plan";
			const next = executionReady
				? "Continue with the numbered task list under the current approval mode."
				: currentMode === "review" ? "Review mode remains read-only; do not execute implementation work." : "Remain in read-only Plan mode until the task list is approved.";
			return { content: [{ type: "text", text: `Saved task list for branch ${id.branch}: ${filePath}. ${next}` }], details: { plan, executionReady } };
		},
	});
	const boardRequest = async <T extends Record<string, unknown>>(event: string, value: T): Promise<Record<string, unknown>> => {
		if (process.env.HERDR_ENV !== "1") throw new Error("Plan Board requires Pi to run inside Herdr (HERDR_ENV=1).");
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			pi.events.emit(event, { ...value, respond: (result: { ok: boolean; error?: string; [key: string]: unknown }) => result.ok ? resolve(result) : reject(new Error(result.error || "Plan Board operation failed.")) });
		});
	};
	pi.registerTool({
		name: "plan_board",
		label: "Plan Board",
		description: "Open, refresh, inspect, or close the dedicated derived Plan Board pane. It never edits the saved plan and never accepts shell commands.",
		promptSnippet: "Display the current plan in the dedicated Herdr Plan Board",
		promptGuidelines: ["Use open explicitly when the user wants the Plan Board displayed.", "Use update after a board scene or plan display needs a fixed refresh; do not use arbitrary commands.", "The board is derived from the authoritative Pi plan; keep approval and HITL decisions in Pi."],
		parameters: Type.Object({ action: Type.Union([Type.Literal("open"), Type.Literal("update"), Type.Literal("status"), Type.Literal("close")]) }),
		renderCall(params, _theme, _context) { return new Markdown(`Plan Board · ${params.action}`, 1, 0, getMarkdownTheme()); },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = await sessionIdentity(ctx);
			currentIdentity = id;
			if (params.action === "close") {
				const result = await boardRequest("herdr:close-plan-board", { role: "plan-board", cwd: ctx.cwd });
				return { content: [{ type: "text", text: `Plan Board closed${result.closed ? "." : " (no pane was closed)."}` }], details: { action: params.action, ...result } };
			}
			if (params.action === "status") {
				const result = await boardRequest("herdr:status-plan-board", { role: "plan-board", cwd: ctx.cwd });
				return { content: [{ type: "text", text: `Plan Board: ${result.status || "unknown"}${result.revision ? ` · revision ${result.revision}` : ""}.` }], details: { action: params.action, ...result } };
			}
			const plan = await loadPlan(id);
			if (!plan) throw new Error("No active plan exists for this branch; create the authoritative Pi plan first.");
			const snapshot = projectPlanBoard(plan);
			const event = params.action === "open" ? "herdr:open-plan-board" : "herdr:update-plan-board";
			const result = await boardRequest(event, { role: "plan-board", cwd: ctx.cwd, socket: "", snapshot });
			return { content: [{ type: "text", text: `Plan Board ${params.action === "open" ? "opened" : "updated"}${result.revision ? ` · revision ${result.revision}` : ""}.` }], details: { action: params.action, status: "ready", ...result } };
		},
	});
	(globalThis as Record<string, unknown>)[PLAN_TOOL_MARKER] = "plan";
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ownsPlanTool) return;
		currentIdentity = await sessionIdentity(ctx);
		const loadedPlan = await loadPlan(currentIdentity);
		activeExecutionPlan = loadedPlan?.execution?.active ? loadedPlan : undefined;
		updateCheckpointWidget(ctx, loadedPlan);
		// Always reconcile the derived board, including draft, completed, and
		// cleared states. A reload must not leave the prior branch on screen.
		emitPlanBoardPlan(pi, ctx, loadedPlan);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ownsPlanTool) return;
		const nextIdentity = await sessionIdentity(ctx);
		if (changedPlanScope(currentIdentity, nextIdentity)) {
			currentIdentity = nextIdentity;
			const loadedPlan = await loadPlan(nextIdentity);
			activeExecutionPlan = loadedPlan?.execution?.active ? loadedPlan : undefined;
			updateCheckpointWidget(ctx, loadedPlan);
			// Scope changes must replace or clear the old board even for drafts.
			emitPlanBoardPlan(pi, ctx, loadedPlan);
		}
		const plan = activeExecutionPlan;
		if (currentMode === "review" || !plan?.execution?.active || plan.steps.length === 0) return;
		const remaining = plan.steps.filter((step) => !isCompleted(step));
		return {
			message: {
				customType: "plan-checkpoints-context",
				content: `[TASK LIST ACTIVE]\nRemaining tasks:\n${remaining.map((step) => `${step.id}. ${step.title}`).join("\n")}\nAfter completing each individual task, immediately include [DONE:n] in your next response using its task number; then continue with the next task.`,
				display: false,
			},
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ownsPlanTool || currentMode === "review") return;
		const plan = activeExecutionPlan;
		if (!plan?.execution?.active) return;
		if (!markCompletedCheckpoints(plan, assistantText(event.message))) return;
		plan.updatedAt = new Date().toISOString();
		if (allCheckpointsComplete(plan)) {
			plan.execution = { ...plan.execution, active: false, completedAt: plan.updatedAt };
			await savePlan(plan);
			emitPlanBoardPlan(pi, ctx, plan);
			activeExecutionPlan = undefined;
			updateCheckpointWidget(ctx, plan);
			ctx.ui.notify(`All tasks complete for ${plan.name}.`, "info");
			return;
		}
		await savePlan(plan);
		emitPlanBoardPlan(pi, ctx, plan);
		updateCheckpointWidget(ctx, plan);
	});

	if (ownsPlanTool) pi.registerCommand("plan", {
		description: "Show or manage the current branch plan",
		handler: async (args, ctx) => {
			const id = await sessionIdentity(ctx);
			currentIdentity = id;
			const action = args.trim() || "status";
			if (action === "clear") {
				await clearPlan(id);
				ctx.ui.notify(`Cleared plan for ${id.branch}.`, "info");
				return;
			}
			const plan = await loadPlan(id);
			ctx.ui.notify(plan ? `${plan.name} · ${id.branch} · ${plan.steps.length} tasks` : `No plan for ${id.branch}.`, "info");
		},
	});
}
