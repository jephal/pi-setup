import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OTHER_OPTION_LABEL, createEditableOptionsComponent } from "../src/pi-ui/index.js";
import { Markdown } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const MODES = ["manual", "approve", "auto", "review", "plan"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ApprovalMode = (typeof MODES)[number];
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const MODE_LABELS: Record<ApprovalMode, string> = {
	manual: "Manual",
	approve: "Approve code edits",
	auto: "Auto",
	review: "Review",
	plan: "Plan",
};

const PLAN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "ask_questions", "plan"]);
const HITL_TOOLS = new Set(["ask_questions", "plan"]);
const PLAN_TOOL_MARKER = "__pi_plan_tool_registered__";

interface PersistedState {
	mode?: ApprovalMode;
	modeBeforePlan?: ApprovalMode;
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
	if (normalized === "plan" || normalized === "planning") return "plan";
	return undefined;
}

// Plan-mode bash is deliberately conservative: one simple, read-only command.
const SAFE_BASH = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|free)\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|ls-)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(rg|fd|bat|eza)\b/i,
];

function isSafePlanBash(command: string): boolean {
	// Do not attempt to interpret shell composition in plan mode.
	if (!command || /[;&|<>`\n\r]|\$\(/.test(command)) return false;
	return SAFE_BASH.some((pattern) => pattern.test(command));
}

function summarizeTool(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") {
		return input.command.length > 500 ? `${input.command.slice(0, 497)}...` : input.command;
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
interface LocalPlan { name: string; content: string; steps: LocalPlanStep[]; identity: LocalPlanIdentity; updatedAt: string; execution?: LocalPlanExecution; }

function planDir(identity: LocalPlanIdentity): string {
	const repoKey = `${identity.repository.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${createHash("sha1").update(identity.root).digest("hex").slice(0, 8)}`;
	return join(homedir(), ".pi", "agent", "plans", repoKey, "sessions", identity.sessionId);
}

async function planIdentity(pi: ExtensionAPI, ctx: ExtensionContext): Promise<LocalPlanIdentity> {
	const run = async (args: string[]) => {
		try { return (await pi.exec("git", ["-C", ctx.cwd, ...args])).stdout.trim(); } catch { return ""; }
	};
	const root = (await run(["rev-parse", "--show-toplevel"])) || ctx.cwd;
	const branch = (await run(["branch", "--show-current"])) || `detached-${(await run(["rev-parse", "--short", "HEAD"])) || "unknown"}`;
	return { repository: root.split("/").pop() || "project", branch, worktree: ctx.cwd, root, sessionId: ctx.sessionManager.getSessionId() };
}

async function saveLocalPlan(plan: LocalPlan): Promise<string> {
	const dir = planDir(plan.identity);
	await mkdir(join(dir, "archive"), { recursive: true });
	await writeFile(join(dir, "current.md"), plan.content, "utf8");
	await writeFile(join(dir, "current.json"), JSON.stringify(plan, null, 2), "utf8");
	await writeFile(join(dir, "current.todo.jsonl"), plan.steps.map((step) => JSON.stringify(step)).join("\n") + "\n", "utf8");
	return join(dir, "current.md");
}

async function clearLocalPlan(identity: LocalPlanIdentity): Promise<void> {
	await rm(planDir(identity), { recursive: true, force: true });
}

async function loadLocalPlan(identity: LocalPlanIdentity): Promise<LocalPlan | undefined> {
	try {
		return JSON.parse(await readFile(join(planDir(identity), "current.json"), "utf8")) as LocalPlan;
	} catch {
		return undefined;
	}
}

function isCompleted(step: LocalPlanStep): boolean {
	return ["complete", "completed", "done"].includes(step.status.trim().toLowerCase());
}

function checkpointMarkdown(content: string, steps: LocalPlanStep[]): string {
	const markdown = content.trim();
	if (!steps.length || /^##\s+task checkpoints\s*$/im.test(markdown)) return markdown;
	const lines = steps.map((step) => `- [${isCompleted(step) ? "x" : " "}] ${step.id}. ${step.title}`);
	return `${markdown}\n\n## Task checkpoints\n\n${lines.join("\n")}`;
}

function checkpointWidgetLines(plan: LocalPlan): string[] {
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

function updateCheckpointWidget(ctx: ExtensionContext, plan: LocalPlan | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget("plan-checkpoints", plan?.execution?.active && plan.steps.length ? checkpointWidgetLines(plan) : undefined, { placement: "aboveEditor" });
}

function reviewOptions() {
	return [
		{ key: "approve-auto", label: "Approve — start execution in Auto mode", description: "Leave Plan mode and continue without per-tool approval prompts.", editable: false },
		{ key: "approve-edits", label: "Approve — start execution with code-edit approvals", description: "Leave Plan mode while keeping bash calls gated.", editable: false },
		{ key: "edit-plan", label: "Edit the plan", description: "Change the plan and review it again.", editable: false },
		{ key: "feedback", label: OTHER_OPTION_LABEL, description: "Press Enter or Tab to write feedback and continue refining in Plan mode.", isOther: true },
	];
}

function explainToolCall(toolName: string, input: Record<string, unknown>): string {
	const path = inputString(input, "path", "filePath", "cwd") ?? "the project";
	if (toolName === "bash") return "The model wants to run a shell command. Review it before allowing execution.";
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
	const ownsPlanTool = (globalThis as Record<string, unknown>)[PLAN_TOOL_MARKER] !== "plan";
	let modeBeforePlan: ApprovalMode = "auto";
	let toolsBeforePlan: string[] | undefined;
	let latestContext: ExtensionContext | undefined;
	const approvalFeedback = new Map<string, string>();


	// pi-plan-mode is the preferred plan owner in the combined setup. Keep this
	// fallback for users who install approval modes by itself, but never register
	// a second plan tool when another package already provides one. The marker is
	// used because getAllTools() is not available during extension loading.
	if (ownsPlanTool) {
	pi.registerTool({
		name: "plan",
		label: "Plan",
		description: "Create, update, review, or clear a complete Markdown plan scoped to this Pi session.",
		promptSnippet: "Create a full structured plan for substantial multi-step changes",
		promptGuidelines: [
			"Use plan action=create for substantial multi-step changes. Start with a concise 'In short' section of 3–7 bullets and a short 'What happens next' section; put technical detail below those sections.",
			"Prefer a plan the user can understand quickly. Include rationale, trade-offs, and validation when useful without repeating the same information.",
			"Use plan action=update after user feedback, plan action=status to inspect progress, and plan action=clear when done.",
			"Provide structured steps for plan create/update so they can be shown as Task checkpoints in the Markdown preview and tracked during execution.",
			"During approved execution, after each individual checkpoint is completed, immediately include [DONE:n] for its step id in your next response; do not wait until all checkpoints are complete, then continue with the next remaining checkpoint.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("status"), Type.Literal("clear")]),
			name: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
			steps: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(Type.Integer()), title: Type.String(), status: Type.Optional(Type.String()) }))),
		}),
		renderCall(params, _theme, _context) {
			// Keep the fallback plan in the ordinary tool transcript. The shared
			// pi-ui component is reserved for the review/feedback gate.
			const steps = (params.steps ?? []).map((step, index) => ({ id: Number(step.id ?? index + 1), title: step.title, status: step.status ?? "pending" }));
			return new Markdown(checkpointMarkdown(params.content?.trim() || "Preparing plan…", steps), 1, 0, getMarkdownTheme());
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const identity = await planIdentity(pi, ctx);
			if (params.action === "clear") {
				await clearLocalPlan(identity);
				activeExecutionPlan = undefined;
				updateCheckpointWidget(ctx, undefined);
				return { content: [{ type: "text", text: `Cleared the active plan for ${identity.branch}.` }], details: { cleared: true, identity } };
			}
			if (params.action === "status") {
				try {
					const content = await readFile(join(planDir(identity), "current.md"), "utf8");
					return { content: [{ type: "text", text: `Active plan for ${identity.branch}:\n${content}` }], details: { identity } };
				} catch {
					return { content: [{ type: "text", text: `No active plan for ${identity.branch}.` }], details: { identity } };
				}
			}
			if (!params.content?.trim()) throw new Error("plan create/update requires complete Markdown content");
			const previous = await loadLocalPlan(identity);
			let plan: LocalPlan = {
				name: params.name?.trim() || previous?.name || "current-plan",
				content: params.content,
				steps: (params.steps ?? previous?.steps ?? []).map((step, index) => ({ id: Number(step.id ?? index + 1), title: step.title, status: step.status ?? "pending" })),
				identity,
				updatedAt: new Date().toISOString(),
				execution: previous?.execution,
			};
			for (;;) {
				const filePath = await saveLocalPlan(plan);
				if (plan.execution?.active && mode !== "plan") {
					activeExecutionPlan = plan;
					updateCheckpointWidget(ctx, plan);
				}
				if (!ctx.hasUI || mode !== "plan") return { content: [{ type: "text", text: `Saved plan to ${filePath}.` }], details: { plan } };
				const review = await ctx.ui.custom<{ key: string; edit?: string } | null>(
					(tui, theme, _keybindings, done) => createEditableOptionsComponent(tui, theme, done, {
						title: `Review plan · ${plan.name}`,
						options: reviewOptions(),
						initialFocus: "options",
					}),
				);
				if (!review) return { content: [{ type: "text", text: `Plan saved to ${filePath}. Review cancelled; remaining in Plan mode.` }], details: { plan, cancelled: true } };
				if (review.key === "edit-plan") {
					const edited = await ctx.ui.editor("Edit plan", plan.content);
					if (edited?.trim()) { plan = { ...plan, content: edited, updatedAt: new Date().toISOString() }; }
					continue;
				}
				if (review.key === "feedback") {
					const feedback = review.edit?.trim() ?? "";
					return { content: [{ type: "text", text: `Keep planning. User feedback: ${feedback || "Please refine the plan."}` }], details: { plan, feedback } };
				}
				const nextMode = review.key === "approve-auto" ? "auto" : "approve";
				const modeLabel = nextMode === "auto" ? "Auto mode" : "code-edit approvals";
				const announcement = `Plan approved. Leaving Plan mode and starting execution with ${modeLabel}.`;
				plan.execution = plan.steps.length ? { active: true, startedAt: new Date().toISOString() } : undefined;
				activeExecutionPlan = plan;
				await saveLocalPlan(plan);
				updateCheckpointWidget(ctx, plan);
				ctx.ui.notify(announcement, "info");
				pi.events.emit("approval-mode:set", { mode: nextMode });
				return { content: [{ type: "text", text: `[PLAN MODE EXITED]\n${announcement}\nThe plan is approved. Begin the implementation now; do not continue planning.` }], details: { plan, choice: review.key, nextMode, executionReady: true, planModeExited: true } };
			}
		},
	});
	(globalThis as Record<string, unknown>)[PLAN_TOOL_MARKER] = "approval";
	}

	pi.registerFlag("approval-mode", {
		description: "Start with an approval mode: manual, approve, auto, review, or plan",
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
		pi.appendEntry("approval-mode", {
			mode,
			modeBeforePlan,
		} satisfies PersistedState);
	}

	function restoreTools(): void {
		if (toolsBeforePlan) pi.setActiveTools(toolsBeforePlan);
		toolsBeforePlan = undefined;
	}

	function planToolNames(): string[] {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		return [...PLAN_TOOLS].filter((tool) => available.has(tool));
	}

	function isReadOnlyMode(value: ApprovalMode): boolean {
		return value === "review" || value === "plan";
	}

	function applyToolPolicy(previous: ApprovalMode, next: ApprovalMode): void {
		const wasReadOnly = isReadOnlyMode(previous);
		const isReadOnly = isReadOnlyMode(next);
		if (isReadOnly && !wasReadOnly) {
			// Take one snapshot when entering the restricted tool policy. Every
			// read-only mode uses the same safe set until we leave it.
			toolsBeforePlan = pi.getActiveTools();
		}
		if (isReadOnly) {
			pi.setActiveTools(planToolNames());
		} else if (wasReadOnly) {
			restoreTools();
		}
	}

	function announcePlanBoundary(previous: ApprovalMode, next: ApprovalMode): void {
		if (previous !== "plan" && next !== "plan") return;
		const entered = next === "plan";
		const transition = entered
			? "[PLAN MODE ENTERED] You are now in read-only Plan mode. Create or refine the plan; do not edit files or execute implementation work."
			: `[PLAN MODE EXITED] Planning is complete. You are now in ${MODE_LABELS[next]} mode; begin implementation instead of continuing to plan.`;
		pi.sendMessage({
			customType: "approval-mode-transition",
			content: transition,
			display: false,
			details: { from: previous, to: next, planMode: entered },
		}, { deliverAs: "nextTurn" });
	}

	function setMode(next: ApprovalMode, ctx: ExtensionContext, shouldPersist = true): void {
		if (next === mode) {
			updateUi(ctx);
			return;
		}

		const previous = mode;
		if (next === "plan") modeBeforePlan = previous;
		applyToolPolicy(previous, next);
		mode = next;
		pi.events.emit("approval-mode:changed", { mode: next });
		announcePlanBoundary(previous, next);
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

	pi.registerCommand("plan", {
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
				ctx.ui.notify("Usage: /mode manual | approve | auto | review | plan", "warning");
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
			if (!PLAN_TOOLS.has(event.toolName)) {
				return { block: true, reason: "Plan mode is read-only: this tool is disabled." };
			}
			if (event.toolName === "bash") {
				const command = typeof event.input.command === "string" ? event.input.command : "";
				if (!isSafePlanBash(command)) {
					return { block: true, reason: "Plan mode only allows simple read-only bash commands." };
				}
			}
			return;
		}

		const needsApproval = mode === "manual" || (mode === "approve" && event.toolName === "bash");
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
		const result = await ctx.ui.custom<{ key: string; edit?: string } | null>(
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
		);
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

	pi.on("before_agent_start", async () => {
		const instructions: Record<ApprovalMode, string> = {
			manual: "Every tool call requires user approval, except ask_questions which is already human-in-the-loop. Do not assume a tool call is allowed.",
			approve: "Read tools, edit, and write may run directly. Every bash call requires user approval. ask_questions is already human-in-the-loop and is not gated twice.",
			auto: "Tools may run without an approval prompt.",
			review: "You are in read-only review mode. Do not edit or write files. Inspect and explain the code, and create a review plan when useful, but do not make changes.",
			plan: "You are in read-only plan mode. Do not edit or write files. Use only safe inspection tools and simple read-only bash commands.",
		};
		let content = `[APPROVAL MODE: ${MODE_LABELS[mode]}]\n${instructions[mode]}\n\n`;
		content += "For substantial multi-step changes, create a complete but concise Plan: before acting. Start with an 'In short' section of 3–7 user-readable bullets and a 'What happens next' section of 3–7 steps. Include rationale, trade-offs, visualizations, implementation phases, and validation when useful, but keep technical detail below the summary and avoid repetition.\n\n";
		content += "When the plan tool is available, use it immediately for substantial multi-step changes: do not write the plan as normal chat. Put the concise summary, next steps, and useful technical detail in plan.create so the plan preview and review selector can appear.\n\n";
		content += mode === "plan"
			? "Plan mode is the locked-in planning workflow: use the plan tool to store the complete Markdown plan and structured phases, then wait for its small review selector before executing. Do not edit or write files. You may use ask_questions for clarification, then revise the complete plan. Wait for the user’s plan decision before executing.\n"
			: "Outside Plan mode, a Plan: is guidance rather than a blocking approval step. Follow the current approval mode and do not wait for a plan decision UI. If a plan tool result says PLAN MODE EXITED or executionReady, begin implementation immediately instead of continuing to plan.\n";
		if (ownsPlanTool && activeExecutionPlan?.execution?.active && activeExecutionPlan.steps.length > 0) {
			const remaining = activeExecutionPlan.steps.filter((step) => !isCompleted(step));
			content += `[PLAN CHECKPOINTS ACTIVE]\nRemaining checkpoints:\n${remaining.map((step) => `${step.id}. ${step.title}`).join("\n")}\nAfter completing each individual checkpoint, immediately include [DONE:n] in your next response using its step id; do not wait until all checkpoints are complete. Then continue with the next remaining checkpoint.\n\n`;
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
		const requested = isMode(flagMode) ? flagMode : isMode(savedMode) ? savedMode : "auto";
		modeBeforePlan = isMode(saved?.data?.modeBeforePlan) ? saved.data.modeBeforePlan : "auto";
		mode = requested;
		applyToolPolicy("auto", mode);
		pi.events.emit("approval-mode:changed", { mode });
		updateUi(ctx);
		if (!ownsPlanTool) return;
		const identity = await planIdentity(pi, ctx);
		activeExecutionPlan = await loadLocalPlan(identity);
		if (!activeExecutionPlan?.execution?.active) activeExecutionPlan = undefined;
		updateCheckpointWidget(ctx, activeExecutionPlan);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!ownsPlanTool) return;
		const plan = activeExecutionPlan;
		if (!plan?.execution?.active) return;
		if (!markCompletedCheckpoints(plan, assistantText(event.message))) return;
		plan.updatedAt = new Date().toISOString();
		if (allCheckpointsComplete(plan)) {
			plan.execution = { ...plan.execution, active: false, completedAt: plan.updatedAt };
			await saveLocalPlan(plan);
			activeExecutionPlan = undefined;
			updateCheckpointWidget(ctx, undefined);
			ctx.ui.notify(`All task checkpoints complete for ${plan.name}.`, "info");
			return;
		}
		await saveLocalPlan(plan);
		updateCheckpointWidget(ctx, plan);
	});
}
