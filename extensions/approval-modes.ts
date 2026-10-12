import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditableOptionsComponent } from "../src/pi-ui/index.ts";
import { Markdown } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { PLAN_BOARD_GUIDANCE, PLAN_CONTEXT_GUIDANCE, checklistMarkdown, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_PROMPT_GUIDELINES, PLAN_TOOL_PROMPT_SNIPPET, planUpdateNotice, taskListWidgetLines } from "./plan-text.ts";
import { clearedPlanBoardSnapshot, projectPlanBoard } from "./plan-board.ts";
import { isReviewModeToolAllowed, isSafeReviewBash, readOnlyToolNames, REVIEW_TOOLS, restoreActiveTools } from "./approval-tools.ts";
import { withHerdrBlock } from "./herdr-blocking.ts";

const MODES = ["manual", "approve", "auto", "review"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ApprovalMode = (typeof MODES)[number];
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const MODE_LABELS: Record<ApprovalMode, string> = {
	manual: "Manual",
	approve: "Approve code edits",
	auto: "Auto",
	review: "Review",
};

const HITL_TOOLS = new Set(["ask_questions", "plan"]);
const PLAN_TOOL_MARKER = "__pi_plan_tool_registered__";

interface PersistedState {
	mode?: ApprovalMode | "plan";
}

function isMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function parseMode(value: string): ApprovalMode | undefined {
	const normalized = value.trim().toLowerCase().replace(/[-_]+/g, " ");
	if (normalized === "manual") return "manual";
	if (normalized === "approve" || normalized === "approve code edits" || normalized === "edits") return "approve";
	if (normalized === "auto" || normalized === "automatic") return "auto";
	if (normalized === "review" || normalized === "reviewing") return "review";
	return undefined;
}

function restoreMode(value: unknown): ApprovalMode | undefined {
	if (isMode(value)) return value;
	// Older sessions persisted Plan mode as read-only. Restore them as Review
	// rather than silently granting the default Auto permissions.
	if (value === "plan" || value === "planning") return "review";
	return undefined;
}

function summarizeTool(toolName: string, input: Record<string, unknown>): string {
	if ((toolName === "bash" || toolName === "herdr_shell") && typeof input.command === "string") {
		const command = input.command.length > 500 ? `${input.command.slice(0, 497)}...` : input.command;
		return toolName === "herdr_shell" ? `Persistent Herdr pane command: ${command}` : command;
	}
	try {
		const json = JSON.stringify(input);
		return json.length > 500 ? `${json.slice(0, 497)}...` : json;
	} catch {
		return toolName;
	}
}

function inputString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
	}
	return undefined;
}

interface LocalPlanIdentity { repository: string; branch: string; worktree: string; root: string; sessionId: string; }
interface LocalPlanStep { id: number; title: string; status: string; }
interface LocalPlanExecution { active: boolean; startedAt?: string; completedAt?: string; }
interface LocalPlan { name: string; kind?: "plan" | "checklist"; content: string; steps: LocalPlanStep[]; identity: LocalPlanIdentity; updatedAt: string; execution?: LocalPlanExecution; }

function planRepositoryDir(identity: LocalPlanIdentity): string {
	const repositorySlug = identity.repository.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
	const repoKey = `${repositorySlug}-${createHash("sha1").update(identity.root).digest("hex").slice(0, 8)}`;
	return join(homedir(), ".pi", "agent", "plans", repoKey);
}

function planDir(identity: LocalPlanIdentity): string {
	const branchSlug = identity.branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
	const branchKey = `${branchSlug}-${createHash("sha1").update(identity.branch).digest("hex").slice(0, 8)}`;
	return join(planRepositoryDir(identity), "branches", branchKey);
}

function legacyPlanDir(identity: LocalPlanIdentity): string {
	return join(planRepositoryDir(identity), "sessions", identity.sessionId);
}

async function planIdentity(pi: ExtensionAPI, ctx: ExtensionContext): Promise<LocalPlanIdentity> {
	const run = async (args: string[]) => {
		try { return (await pi.exec("git", ["-C", ctx.cwd, ...args])).stdout.trim(); } catch { return ""; }
	};
	const root = (await run(["rev-parse", "--show-toplevel"])) || ctx.cwd;
	const branch = (await run(["branch", "--show-current"])) || `detached-${(await run(["rev-parse", "--short", "HEAD"])) || "unknown"}`;
	return { repository: root.split("/").pop() || "project", branch, worktree: ctx.cwd, root, sessionId: ctx.sessionManager.getSessionId() };
}

async function writeLocalPlanAtomically(filePath: string, content: string): Promise<void> {
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, content, "utf8");
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function saveLocalPlan(plan: LocalPlan): Promise<string> {
	const dir = planDir(plan.identity);
	await mkdir(join(dir, "archive"), { recursive: true });
	await Promise.all([
		writeLocalPlanAtomically(join(dir, "current.md"), plan.content),
		writeLocalPlanAtomically(join(dir, "current.todo.jsonl"), plan.steps.map((step) => JSON.stringify(step)).join("\n") + "\n"),
	]);
	await writeLocalPlanAtomically(join(dir, "current.json"), JSON.stringify(plan, null, 2));
	return join(dir, "current.md");
}

async function clearLocalPlan(identity: LocalPlanIdentity): Promise<void> {
	await Promise.all([
		rm(planDir(identity), { recursive: true, force: true }),
		rm(legacyPlanDir(identity), { recursive: true, force: true }),
	]);
}

async function readLocalPlan(dir: string): Promise<LocalPlan | undefined> {
	try {
		return JSON.parse(await readFile(join(dir, "current.json"), "utf8")) as LocalPlan;
	} catch {
		return undefined;
	}
}

async function loadLocalPlan(identity: LocalPlanIdentity): Promise<LocalPlan | undefined> {
	return (await readLocalPlan(planDir(identity))) ?? readLocalPlan(legacyPlanDir(identity));
}

function isCompleted(step: LocalPlanStep): boolean {
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

function markCompletedCheckpoints(plan: LocalPlan, text: string): boolean {
	let changed = false;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = plan.steps.find((candidate) => candidate.id === Number(match[1]));
		if (step && !isCompleted(step)) {
			step.status = "completed";
			changed = true;
		}
	}
	return changed;
}

function allCheckpointsComplete(plan: LocalPlan): boolean {
	return plan.steps.length > 0 && plan.steps.every(isCompleted);
}

function emitLocalPlanBoard(pi: ExtensionAPI, ctx: ExtensionContext, plan: LocalPlan | undefined): void {
	const snapshot = plan ? projectPlanBoard(plan as any) : clearedPlanBoardSnapshot({ name: "Plan Board", repository: "project", branch: "unknown", root: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
	pi.events.emit("plan-board:plan", { cwd: ctx.cwd, snapshot });
}

function updateCheckpointWidget(ctx: ExtensionContext, plan: LocalPlan | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget("plan-checkpoints", plan?.steps.length ? taskListWidgetLines(plan.steps) : undefined, { placement: "aboveEditor" });
}

function queuePlanUpdateExplanation(pi: ExtensionAPI, previous: LocalPlan, next: LocalPlan): void {
	pi.sendMessage({
		customType: "plan-update-context",
		content: planUpdateNotice(previous, next),
		display: false,
		details: { previousName: previous.name, nextName: next.name },
	}, { deliverAs: "steer" });
}

function explainToolCall(toolName: string, input: Record<string, unknown>): string {
	const path = inputString(input, "path", "filePath", "cwd") ?? "the project";
	if (toolName === "bash") return "The model wants to run a shell command. Review it before allowing execution.";
	if (toolName === "herdr_shell") {
		const action = inputString(input, "action") ?? "open";
		return action === "run" || action === "open"
			? "The model wants to start a command in a persistent visible Herdr pane. Review the command because it may keep running after this turn."
			: `The model wants to ${action.replaceAll("_", " ")} a managed Herdr pane.`;
	}
	if (toolName === "read") return `The model wants to read ${path}.`;
	if (toolName === "write") return `The model wants to write or replace ${path}.`;
	if (toolName === "edit") return `The model wants to modify ${path}.`;
	if (toolName === "grep") {
		const pattern = inputString(input, "pattern", "query") ?? "a pattern";
		return `The model wants to search ${path} for ${JSON.stringify(pattern)}.`;
	}
	if (toolName === "find") return `The model wants to find files under ${path}.`;
	if (toolName === "ls") return `The model wants to list ${path}.`;
	return `The model wants to call the ${toolName} tool.`;
}

export default function approvalModes(pi: ExtensionAPI): void {

	let mode: ApprovalMode = "auto";
	let activeExecutionPlan: LocalPlan | undefined;
	let currentPlanIdentity: LocalPlanIdentity | undefined;
	const ownsPlanTool = (globalThis as Record<string, unknown>)[PLAN_TOOL_MARKER] !== "plan";
	let toolsBeforePlan: string[] | undefined;
	let temporaryReadOnlyTools: ReadonlySet<string> | undefined;
	let latestContext: ExtensionContext | undefined;
	const approvalFeedback = new Map<string, string>();


	// The dedicated plans extension is the preferred plan owner in the combined
	// setup. Keep this fallback when approval modes is installed by itself, but never register
	// a second plan tool when another package already provides one. The marker is
	// used because getAllTools() is not available during extension loading.
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
			steps: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(Type.Integer()), title: Type.String({ description: "Short numbered task text for the above-editor list" }), status: Type.Optional(Type.String()) }))),
		}),
		renderCall(params, _theme, _context) {
			const steps = (params.steps ?? []).map((step, index) => ({ id: Number(step.id ?? index + 1), title: step.title, status: step.status ?? "pending" }));
			return new Markdown(steps.length ? checklistMarkdown(params.name?.trim() || "current-task-list", steps) : "Preparing task list…", 1, 0, getMarkdownTheme());
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const identity = await planIdentity(pi, ctx);
			if (params.action === "clear") {
				await clearLocalPlan(identity);
				activeExecutionPlan = undefined;
				updateCheckpointWidget(ctx, undefined);
				emitLocalPlanBoard(pi, ctx, undefined);
				return { content: [{ type: "text", text: `Cleared the active plan for ${identity.branch}.` }], details: { cleared: true, identity } };
			}
			if (params.action === "status") {
				const plan = await loadLocalPlan(identity);
				const tasks = plan?.steps.length ? checklistMarkdown(plan.name, plan.steps) : "- No task steps saved";
				return { content: [{ type: "text", text: plan ? `Task list · ${plan.name}\n${tasks}` : `No task list for ${identity.branch}.` }], details: plan ? { identity, plan } : { identity } };
			}
			const previous = await loadLocalPlan(identity);
			const steps = (params.steps ?? previous?.steps ?? []).map((step, index) => ({ id: Number(step.id ?? index + 1), title: step.title, status: step.status ?? "pending" }));
			if (!steps.length) throw new Error("plan create/update requires at least one numbered task step.");
			const name = params.name?.trim() || previous?.name || "current-task-list";
			const plan: LocalPlan = {
				name,
				kind: "checklist",
				content: checklistMarkdown(name, steps),
				steps,
				identity,
				updatedAt: new Date().toISOString(),
				execution: previous?.execution,
			};
			if (mode !== "review" && !plan.execution?.active) plan.execution = { active: true, startedAt: new Date().toISOString() };
			const filePath = await saveLocalPlan(plan);
			emitLocalPlanBoard(pi, ctx, plan);
			activeExecutionPlan = plan.execution?.active ? plan : undefined;
			updateCheckpointWidget(ctx, plan);
			if (params.action === "update" && previous) queuePlanUpdateExplanation(pi, previous, plan);
			const executionReady = mode !== "review";
			const next = executionReady
				? "Continue with the numbered task list under the current approval mode."
				: "Review mode remains read-only; do not execute implementation work.";
			return { content: [{ type: "text", text: `Saved task list for branch ${identity.branch}: ${filePath}. ${next}` }], details: { plan, executionReady } };
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
		promptGuidelines: [PLAN_BOARD_GUIDANCE],
		parameters: Type.Object({ action: Type.Union([Type.Literal("open"), Type.Literal("update"), Type.Literal("status"), Type.Literal("close")]) }),
		renderCall(params, _theme, _context) { return new Markdown(`Plan Board · ${params.action}`, 1, 0, getMarkdownTheme()); },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const identity = await planIdentity(pi, ctx);
			if (params.action === "close") {
				const result = await boardRequest("herdr:close-plan-board", { role: "plan-board", cwd: ctx.cwd });
				return { content: [{ type: "text", text: `Plan Board closed${result.closed ? "." : " (no pane was closed)."}` }], details: { action: params.action, ...result } };
			}
			if (params.action === "status") {
				const result = await boardRequest("herdr:status-plan-board", { role: "plan-board", cwd: ctx.cwd });
				return { content: [{ type: "text", text: `Plan Board: ${result.status || "unknown"}${result.revision ? ` · revision ${result.revision}` : ""}.` }], details: { action: params.action, ...result } };
			}
			const plan = await loadLocalPlan(identity);
			if (!plan) throw new Error("No active plan exists for this branch; create the authoritative Pi plan first.");
			const snapshot = projectPlanBoard(plan as any);
			const event = params.action === "open" ? "herdr:open-plan-board" : "herdr:update-plan-board";
			const result = await boardRequest(event, { role: "plan-board", cwd: ctx.cwd, socket: "", snapshot });
			return { content: [{ type: "text", text: `Plan Board ${params.action === "open" ? "opened" : "updated"}${result.revision ? ` · revision ${result.revision}` : ""}.` }], details: { action: params.action, status: "ready", ...result } };
		},
	});
	(globalThis as Record<string, unknown>)[PLAN_TOOL_MARKER] = "approval";
	}

	pi.registerFlag("approval-mode", {
		description: "Start with an approval mode: manual, approve, auto, or review",
		type: "string",
		default: "auto",
	});

	pi.events.on("approval-mode:set", (data) => {
		if (!latestContext || !data || typeof data !== "object" || !("mode" in data)) return;
		const requested = (data as { mode?: unknown }).mode;
		if (isMode(requested)) setMode(requested, latestContext);
	});

	function updateUi(ctx: ExtensionContext): void {
		latestContext = ctx;
		const modeText = MODE_LABELS[mode];
		const suffix = "";
		ctx.ui.setStatus(
			"approval-mode",
			ctx.ui.theme.fg(mode === "auto" ? "success" : "accent", `${modeText}${suffix}`),
		);
	}

	function persist(): void {
		pi.appendEntry("approval-mode", { mode } satisfies PersistedState);
	}

	function restoreTools(): void {
		if (toolsBeforePlan) pi.setActiveTools(restoreActiveTools(toolsBeforePlan, pi.getActiveTools(), temporaryReadOnlyTools));
		toolsBeforePlan = undefined;
		temporaryReadOnlyTools = undefined;
	}

	function isReadOnlyMode(value: ApprovalMode): boolean {
		return value === "review";
	}

	function applyToolPolicy(previous: ApprovalMode, next: ApprovalMode): void {
		const wasReadOnly = isReadOnlyMode(previous);
		const isReadOnly = isReadOnlyMode(next);
		if (isReadOnly && !wasReadOnly) {
			toolsBeforePlan = pi.getActiveTools();
		}
		if (isReadOnly) {
			temporaryReadOnlyTools = REVIEW_TOOLS;
			pi.setActiveTools(readOnlyToolNames(pi.getAllTools().map((tool) => tool.name)));
		} else if (wasReadOnly) {
			restoreTools();
		}
	}

	function setMode(next: ApprovalMode, ctx: ExtensionContext, shouldPersist = true): void {
		if (next === mode) {
			updateUi(ctx);
			return;
		}

		const previous = mode;
		applyToolPolicy(previous, next);
		mode = next;
		pi.events.emit("approval-mode:changed", { mode: next });
		updateUi(ctx);
		if (shouldPersist) persist();
	}

	function cycleMode(ctx: ExtensionContext): void {
		const index = MODES.indexOf(mode);
		const next = MODES[(index + 1) % MODES.length];
		setMode(next, ctx);
		ctx.ui.notify(`Approval mode: ${MODE_LABELS[next]}`, next === "auto" ? "warning" : "info");
	}

	pi.registerShortcut("shift+tab", {
		description: "Cycle approval mode",
		handler: (ctx) => cycleMode(ctx),
	});

	if (ownsPlanTool) pi.registerCommand("plan", {
		description: "Show or clear the current session plan",
		handler: async (args, ctx) => {
			const identity = await planIdentity(pi, ctx);
			if (args.trim() === "clear") { await clearLocalPlan(identity); ctx.ui.notify(`Cleared plan for ${identity.branch}.`, "info"); return; }
			ctx.ui.notify(`Plan tool storage: ${planDir(identity)}`, "info");
		},
	});

	const selectThinkingLevel = async (args: string, ctx: ExtensionContext) => {
		const requested = args.trim().toLowerCase() as ThinkingLevel | "";
		if (requested && !THINKING_LEVELS.includes(requested as ThinkingLevel)) {
			ctx.ui.notify(`Usage: /thinking-level [${THINKING_LEVELS.join(" | ")}]`, "warning");
			return;
		}
		if (requested) {
			pi.setThinkingLevel(requested);
			ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
			return;
		}

		const current = pi.getThinkingLevel();
		const choice = await ctx.ui.select(`Thinking level · current: ${current}`, [...THINKING_LEVELS]);
		if (choice && THINKING_LEVELS.includes(choice as ThinkingLevel)) {
			pi.setThinkingLevel(choice as ThinkingLevel);
			ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
		}
	};

	pi.registerCommand("thinking-level", {
		description: "Select thinking level (replaces Shift+Tab)",
		getArgumentCompletions: () =>
			THINKING_LEVELS.map((value) => ({ value, label: value, description: `Set thinking level to ${value}` })),
		handler: selectThinkingLevel,
	});

	pi.registerCommand("mode", {
		description: "Show or set approval mode",
		getArgumentCompletions: () =>
			MODES.map((value) => ({ value, label: MODE_LABELS[value], description: `Switch to ${MODE_LABELS[value]}` })),
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify(`Approval mode: ${MODE_LABELS[mode]}\nShift+Tab cycles modes.`, "info");
				return;
			}
			const next = parseMode(requested);
			if (!next) {
				ctx.ui.notify("Usage: /mode manual | approve | auto | review", "warning");
				return;
			}
			setMode(next, ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		// ask_questions already obtains an explicit human decision, so do not
		// put a second approval dialog in front of that HITL interaction.
		if (HITL_TOOLS.has(event.toolName) || mode === "auto") return;

		if (isReadOnlyMode(mode)) {
			if (!isReviewModeToolAllowed(event.toolName, event.input)) {
				return { block: true, reason: `${MODE_LABELS[mode]} mode is read-only: this tool is disabled.` };
			}
			if (event.toolName === "bash") {
				const command = typeof event.input.command === "string" ? event.input.command : "";
				if (!isSafeReviewBash(command)) {
					return { block: true, reason: `${MODE_LABELS[mode]} mode only allows simple read-only bash commands.` };
				}
			}
			return;
		}

		const isHerdrShellCommand = event.toolName === "herdr_shell" && (event.input.action === "open" || event.input.action === "run");
		const needsApproval = mode === "manual" || (mode === "approve" && (event.toolName === "bash" || isHerdrShellCommand));
		if (!needsApproval) return;
		if (!ctx.hasUI) {
			return { block: true, reason: `Approval mode ${MODE_LABELS[mode]} requires interactive confirmation.` };
		}

		// Enrich a display-only copy of the tool input. Do not mutate the actual
		// built-in tool input: its schema does not include this extra field.
		const approvalInput = {
			...event.input,
			humanReadableExplanation: explainToolCall(event.toolName, event.input),
		};
		const description = summarizeTool(event.toolName, event.input);
		const result = await withHerdrBlock(pi, "Waiting for approval", () => ctx.ui.custom<{ key: string; edit?: string } | null>(
			(tui, theme, _keybindings, done) => createEditableOptionsComponent(tui, theme, done, {
				title: approvalInput.humanReadableExplanation,
				details: [`  ${description}`],
				options: [
					{ key: "yes", label: "Yes" },
					{ key: "no", label: "No" },
				],
				optionsFocusHint: "",
				optionsHint: "↑↓ choose · Tab edit feedback · Enter confirm · Esc cancel",
				editingHint: "Tab save · Enter approve/deny · arrows stop editing · Esc cancel",
			}),
		));
		if (!result) return { block: true, reason: `Blocked by ${MODE_LABELS[mode]} approval gate.` };
		const approved = result.key === "yes";
		if (!approved) {
			const feedback = result.edit ? ` User feedback: ${result.edit}` : "";
			return { block: true, reason: `Blocked by ${MODE_LABELS[mode]} approval gate.${feedback}` };
		}
		if (result.edit) {
			approvalFeedback.set(event.toolCallId, result.edit);
			ctx.ui.notify(`Approved with feedback: ${result.edit}`, "info");
		}
	});

	pi.on("tool_result", async (event) => {
		const feedback = approvalFeedback.get(event.toolCallId);
		if (!feedback) return;
		approvalFeedback.delete(event.toolCallId);
		return {
			content: [
				...event.content,
				{ type: "text", text: `User approval feedback: ${feedback}` },
			],
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (ownsPlanTool) {
			const nextIdentity = await planIdentity(pi, ctx);
			if (!currentPlanIdentity || currentPlanIdentity.root !== nextIdentity.root || currentPlanIdentity.branch !== nextIdentity.branch || currentPlanIdentity.sessionId !== nextIdentity.sessionId) {
				currentPlanIdentity = nextIdentity;
				const loadedPlan = await loadLocalPlan(nextIdentity);
				activeExecutionPlan = loadedPlan?.execution?.active ? loadedPlan : undefined;
				updateCheckpointWidget(ctx, loadedPlan);
				// Branch/worktree changes replace the board even when the new scope
				// has only a draft or no plan.
				emitLocalPlanBoard(pi, ctx, loadedPlan);
			}
		}
		const instructions: Record<ApprovalMode, string> = {
			manual: "Every tool call requires user approval, except ask_questions which is already human-in-the-loop. Do not assume a tool call is allowed.",
			approve: "Read tools, edit, and write may run directly. Every bash call requires user approval. ask_questions is already human-in-the-loop and is not gated twice.",
			auto: "Tools may run without an approval prompt.",
			review: "You are in read-only review mode for project files. Do not edit or write project files or perform implementation. You may use the plan tool to save a planning reference, but do not execute it.",
		};
		let content = `[APPROVAL MODE: ${MODE_LABELS[mode]}]\n${instructions[mode]}\n\n${PLAN_CONTEXT_GUIDANCE} If a saved plan returns executionReady, begin implementation under the current mode's permissions.\n`;
		if (ownsPlanTool && mode !== "review" && activeExecutionPlan?.execution?.active && activeExecutionPlan.steps.length > 0) {
			const remaining = activeExecutionPlan.steps.filter((step) => !isCompleted(step));
			content += `[TASK LIST ACTIVE]\nRemaining tasks:\n${remaining.map((step) => `${step.id}. ${step.title}`).join("\n")}\nAfter completing each individual task, immediately include [DONE:n] in your next response using its task number; then continue with the next task.\n\n`;
		}
		return {
			message: {
				customType: "approval-mode-context",
				content,
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const saved = [...entries]
			.reverse()
			.find((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === "approval-mode") as
			| { data?: PersistedState }
			| undefined;
		const flagMode = pi.getFlag("approval-mode");
		const savedMode = saved?.data?.mode;
		const requested = restoreMode(flagMode) ?? restoreMode(savedMode) ?? "auto";
		mode = requested;
		applyToolPolicy("auto", mode);
		pi.events.emit("approval-mode:changed", { mode });
		updateUi(ctx);
		if (!ownsPlanTool) return;
		const identity = await planIdentity(pi, ctx);
		currentPlanIdentity = identity;
		const loadedPlan = await loadLocalPlan(identity);
		activeExecutionPlan = loadedPlan?.execution?.active ? loadedPlan : undefined;
		updateCheckpointWidget(ctx, loadedPlan);
		// Reconcile every loaded state so a reload cannot display a prior branch.
		emitLocalPlanBoard(pi, ctx, loadedPlan);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ownsPlanTool || mode === "review") return;
		const plan = activeExecutionPlan;
		if (!plan?.execution?.active) return;
		if (!markCompletedCheckpoints(plan, assistantText(event.message))) return;
		plan.updatedAt = new Date().toISOString();
		if (allCheckpointsComplete(plan)) {
			plan.execution = { ...plan.execution, active: false, completedAt: plan.updatedAt };
			await saveLocalPlan(plan);
			emitLocalPlanBoard(pi, ctx, plan);
			activeExecutionPlan = undefined;
			updateCheckpointWidget(ctx, plan);
			ctx.ui.notify(`All tasks complete for ${plan.name}.`, "info");
			return;
		}
		await saveLocalPlan(plan);
		emitLocalPlanBoard(pi, ctx, plan);
		updateCheckpointWidget(ctx, plan);
	});
}
