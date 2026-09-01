import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { OTHER_OPTION_LABEL, createEditableOptionsComponent } from "../src/pi-ui/index.js";
import { Type } from "typebox";
import { checklistMarkdown, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_PROMPT_GUIDELINES, PLAN_TOOL_PROMPT_SNIPPET } from "./plan-text.ts";
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
	return !left || left.root !== right.root || left.branch !== right.branch;
}

function parseSteps(input: unknown): PlanStep[] {
	if (!Array.isArray(input)) return [];
	return input.map((step, index) => {
		const value = step as Record<string, unknown>;
		return { id: Number(value.id ?? index + 1), title: String(value.title ?? `Phase ${index + 1}`), status: String(value.status ?? "pending") };
	});
}

function isCompleted(step: PlanStep): boolean {
	return ["complete", "completed", "done"].includes(step.status.trim().toLowerCase());
}

function checkpointMarkdown(content: string, steps: PlanStep[]): string {
	const markdown = content.trim();
	if (!steps.length || /^##\s+task checkpoints\s*$/im.test(markdown)) return markdown;
	const lines = steps.map((step) => {
		const checkbox = isCompleted(step) ? "x" : " ";
		const progress = step.status.trim().toLowerCase() === "in_progress" ? " *(in progress)*" : "";
		return `- [${checkbox}] ${step.id}. ${step.title}${progress}`;
	});
	return `${markdown}\n\n## Task checkpoints\n\n${lines.join("\n")}`;
}

function checkpointWidgetLines(plan: StoredPlan): string[] {
	const completed = plan.steps.filter(isCompleted).length;
	return [
		`Task checkpoints · ${completed}/${plan.steps.length}`,
		...plan.steps.map((step) => {
			const status = step.status.trim().toLowerCase();
			const marker = isCompleted(step) ? "☑" : status === "in_progress" ? "◐" : "☐";
			return `${marker} ${step.id}. ${step.title}`;
		}),
	];
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

function updateCheckpointWidget(ctx: ExtensionContext, plan: StoredPlan | undefined): void {
	if (!ctx.hasUI) return;
	if (!plan?.execution?.active || plan.steps.length === 0) {
		ctx.ui.setWidget("plan-checkpoints", undefined);
		return;
	}
	ctx.ui.setWidget("plan-checkpoints", checkpointWidgetLines(plan), { placement: "aboveEditor" });
}

function reviewOptions() {
	return [
		{ key: "approve-auto", label: "Approve — start execution in Auto mode", description: "Leave Plan mode and continue without per-tool approval prompts.", editable: false },
		{ key: "approve-edits", label: "Approve — start execution with code-edit approvals", description: "Leave Plan mode while keeping bash calls gated.", editable: false },
		{ key: "edit-plan", label: "Edit the plan", description: "Change the plan and review it again.", editable: false },
		{ key: "feedback", label: OTHER_OPTION_LABEL, description: "Press Enter or Tab to write feedback and continue refining in Plan mode.", isOther: true },
	];
}

export default function planMode(pi: ExtensionAPI): void {
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
			content: Type.Optional(Type.String()),
			steps: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(Type.Integer()), title: Type.String(), status: Type.Optional(Type.String()) }))),
		}),
		renderCall(params, _theme, _context) {
			// Keep the plan in the ordinary tool transcript. The review gate below
			// is the only specialized UI; the plan itself uses Pi's normal Markdown
			// renderer instead of a persisted custom entry.
			const steps = parseSteps(params.steps);
			const content = params.content?.trim() || (steps.length ? checklistMarkdown(params.name?.trim() || "current-checklist", steps) : "Preparing checklist…");
			return new Markdown(checkpointMarkdown(content, steps), 1, 0, getMarkdownTheme());
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = await sessionIdentity(ctx);
			currentIdentity = id;
			if (params.action === "status") {
				const plan = await loadPlan(id);
				const label = plan?.kind === "checklist" ? "Active checklist" : "Active plan";
				return { content: [{ type: "text", text: plan ? `${label}: ${plan.name} (${plan.steps.length} ${plan.kind === "checklist" ? "items" : "phases"})` : "No active plan for this branch." }], details: plan ?? {} };
			}
			if (params.action === "clear") {
				await clearPlan(id);
				activeExecutionPlan = undefined;
				updateCheckpointWidget(ctx, undefined);
				return { content: [{ type: "text", text: `Cleared the active plan for ${id.branch}.` }], details: { cleared: true, branch: id.branch } };
			}
			const previous = await loadPlan(id);
			if (currentMode !== "plan") {
				if (params.content?.trim()) throw new Error("Outside Plan mode, create/update accepts checklist steps only. Enter Plan mode for a full Markdown plan.");
				const steps = parseSteps(params.steps ?? previous?.steps);
				if (!steps.length) throw new Error("Outside Plan mode, create/update requires at least one checklist step. Enter Plan mode for a full Markdown plan.");
				const name = params.name?.trim() || previous?.name || "current-checklist";
				const plan: StoredPlan = {
					name,
					kind: previous?.execution?.active ? (previous.kind ?? "plan") : "checklist",
					content: previous?.execution?.active ? previous.content : checklistMarkdown(name, steps),
					steps,
					identity: id,
					updatedAt: new Date().toISOString(),
					execution: previous?.execution?.active ? previous.execution : undefined,
				};
				const filePath = await savePlan(plan);
				if (plan.execution?.active) {
					activeExecutionPlan = plan;
					updateCheckpointWidget(ctx, plan);
				}
				return { content: [{ type: "text", text: `Saved checklist for branch ${id.branch}: ${filePath}` }], details: { plan, checklistOnly: true } };
			}
			if (!params.content?.trim()) throw new Error("plan create/update requires full Markdown content");
			const plan: StoredPlan = {
				name: params.name?.trim() || previous?.name || "current-plan",
				kind: "plan",
				content: params.content,
				steps: parseSteps(params.steps ?? previous?.steps),
				identity: id,
				updatedAt: new Date().toISOString(),
				execution: previous?.execution,
			};
			let filePath = await savePlan(plan);
			if (plan.execution?.active && currentMode !== "plan") {
				activeExecutionPlan = plan;
				updateCheckpointWidget(ctx, plan);
			}
			if (ctx.hasUI && currentMode === "plan") {
				for (;;) {
					const review = await ctx.ui.custom<{ key: string; edit?: string } | null>(
						(tui, theme, _keybindings, done) => createEditableOptionsComponent(tui, theme, done, {
							title: `Review plan · ${plan.name}`,
							options: reviewOptions(),
							initialFocus: "options",
						}),
					);
					if (!review) {
						return { content: [{ type: "text", text: `Plan saved to ${filePath}. Review cancelled; remaining in Plan mode.` }], details: { plan, cancelled: true } };
					}
					if (review.key === "edit-plan") {
						const edited = await ctx.ui.editor("Edit plan", plan.content);
						if (edited?.trim()) {
							plan.content = edited;
							plan.updatedAt = new Date().toISOString();
							filePath = await savePlan(plan);
						}
						continue;
					}
					if (review.key === "feedback") {
						const feedback = review.edit?.trim() ?? "";
						return { content: [{ type: "text", text: `Plan saved to ${filePath}. Keep planning with this feedback: ${feedback || "Please refine the plan."}` }], details: { plan, choice: review.key, feedback } };
					}
					const nextMode = review.key === "approve-auto" ? "auto" : "approve";
					const modeLabel = nextMode === "auto" ? "Auto mode" : "code-edit approvals";
					const announcement = `Plan approved. Leaving Plan mode and starting execution with ${modeLabel}.`;
					plan.execution = plan.steps.length ? { active: true, startedAt: new Date().toISOString() } : undefined;
					activeExecutionPlan = plan;
					filePath = await savePlan(plan);
					updateCheckpointWidget(ctx, plan);
					ctx.ui.notify(announcement, "info");
					pi.events.emit("approval-mode:set", { mode: nextMode });
					return { content: [{ type: "text", text: `[PLAN MODE EXITED]\n${announcement}\nThe plan is approved. Begin the implementation now; do not continue planning.` }], details: { plan, choice: review.key, nextMode, executionReady: true, planModeExited: true } };
				}
			}
			return { content: [{ type: "text", text: `Saved plan for branch ${id.branch}: ${filePath}` }], details: { plan } };
		},
	});
	(globalThis as Record<string, unknown>)[PLAN_TOOL_MARKER] = "plan";
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ownsPlanTool) return;
		currentIdentity = await sessionIdentity(ctx);
		activeExecutionPlan = await loadPlan(currentIdentity);
		if (!activeExecutionPlan?.execution?.active) activeExecutionPlan = undefined;
		updateCheckpointWidget(ctx, activeExecutionPlan);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ownsPlanTool) return;
		const nextIdentity = await sessionIdentity(ctx);
		if (changedPlanScope(currentIdentity, nextIdentity)) {
			currentIdentity = nextIdentity;
			activeExecutionPlan = await loadPlan(nextIdentity);
			if (!activeExecutionPlan?.execution?.active) activeExecutionPlan = undefined;
			updateCheckpointWidget(ctx, activeExecutionPlan);
		}
		const plan = activeExecutionPlan;
		if (!plan?.execution?.active || plan.steps.length === 0) return;
		const remaining = plan.steps.filter((step) => !isCompleted(step));
		return {
			message: {
				customType: "plan-checkpoints-context",
				content: `[PLAN CHECKPOINTS ACTIVE]\nRemaining checkpoints:\n${remaining.map((step) => `${step.id}. ${step.title}`).join("\n")}\nAfter completing each individual checkpoint, immediately include [DONE:n] in your next response using its step id; do not wait until all checkpoints are complete. Then continue with the next remaining checkpoint.`,
				display: false,
			},
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ownsPlanTool) return;
		const plan = activeExecutionPlan;
		if (!plan?.execution?.active) return;
		if (!markCompletedCheckpoints(plan, assistantText(event.message))) return;
		plan.updatedAt = new Date().toISOString();
		if (allCheckpointsComplete(plan)) {
			plan.execution = { ...plan.execution, active: false, completedAt: plan.updatedAt };
			await savePlan(plan);
			activeExecutionPlan = undefined;
			updateCheckpointWidget(ctx, undefined);
			ctx.ui.notify(`All task checkpoints complete for ${plan.name}.`, "info");
			return;
		}
		await savePlan(plan);
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
			ctx.ui.notify(plan ? `${plan.name} · ${id.branch} · ${plan.steps.length} phases` : `No plan for ${id.branch}.`, "info");
		},
	});
}
