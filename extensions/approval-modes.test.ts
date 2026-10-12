import assert from "node:assert/strict";
import test from "node:test";
import { isPlanModeToolAllowed, isPlanModeVisualizationAllowed, isReviewModeToolAllowed, isReviewModeVisualizationAllowed, isSafeReadOnlyBash, readOnlyToolNames, restoreActiveTools, PLAN_TOOLS, REVIEW_TOOLS } from "./approval-tools.ts";
import approvalModes from "./approval-modes.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("read-only mode bash safety rejects mutating Git commands and shell composition", () => {
	assert.equal(isSafeReadOnlyBash("git status --short"), true);
	assert.equal(isSafeReadOnlyBash("git branch -D feature"), false);
	assert.equal(isSafeReadOnlyBash("git remote add origin https://example.test"), false);
	assert.equal(isSafeReadOnlyBash("git status && rm -rf ."), false);
	assert.equal(isSafeReadOnlyBash("git rev-parse --show-toplevel"), true);
});

test("Review keeps planning and previews available but blocks writes and persistent visuals", () => {
	for (const tool of ["plan", "repo_search", "plan_board", "visualize", "tool_search"]) {
		assert.equal(REVIEW_TOOLS.has(tool), true, tool);
	}
	assert.equal(REVIEW_TOOLS.has("notes_list"), false);
	assert.equal(isReviewModeToolAllowed("plan"), true);
	assert.equal(isReviewModeToolAllowed("write"), false);
	assert.equal(isReviewModeToolAllowed("mcp__datadog__logs"), true);
	assert.equal(isReviewModeToolAllowed("mcp__datadog__create_monitor"), false);
	assert.equal(isReviewModeVisualizationAllowed({ action: "preview", format: "mermaid", source: "graph TD\nA" }), true);
	assert.equal(isReviewModeVisualizationAllowed({ action: "viewer", format: "excalidraw", nodes: [{ id: "a", label: "A" }] }), true);
	assert.equal(isReviewModeVisualizationAllowed({ action: "terminal_viewer", target: "open" }), false);
	assert.equal(isReviewModeVisualizationAllowed({ action: "artifact" }), false);
	assert.deepEqual(
		readOnlyToolNames("review", ["read", "plan", "repo_search", "visualize", "tool_search", "notes_list", "memory"]),
		["read", "plan", "repo_search", "visualize", "tool_search"],
	);
});

test("strict Plan mode has a broader read-only tool set and only permits visualization previews", () => {
	for (const tool of ["notes_list", "notes_read", "fovea_focus", "scheduled_task_list", "tool_search", "repo_search"]) {
		assert.equal(PLAN_TOOLS.has(tool), true, tool);
	}
	for (const tool of ["notes_write", "memory", "herdr_shell", "scheduled_task_create", "scheduled_task_delete"]) {
		assert.equal(PLAN_TOOLS.has(tool), false, tool);
	}
	assert.equal(isPlanModeToolAllowed("mcp__datadog__logs"), true);
	assert.equal(isPlanModeToolAllowed("mcp__datadog__create_monitor"), false);
	assert.equal(isPlanModeToolAllowed("visualize", { action: "preview", format: "mermaid", source: "graph TD\nA" }), true);
	assert.equal(isPlanModeToolAllowed("visualize", { action: "artifact" }), false);
	assert.equal(isPlanModeVisualizationAllowed({ action: "viewer", format: "excalidraw" }), false);
	assert.deepEqual(readOnlyToolNames("plan", ["read", "plan", "repo_search", "notes_list", "fovea_focus", "tool_search"]), ["read", "plan", "repo_search", "tool_search", "notes_list", "fovea_focus"]);
});

test("leaving Review mode preserves dynamically activated tools", () => {
	assert.deepEqual(
		restoreActiveTools(
			["read", "tool_search"],
			["read", "grep", "plan", "tool_search", "mcp__datadog__logs"],
		),
		["read", "tool_search", "mcp__datadog__logs"],
	);
});

test("persisted strict Plan mode restores read-only policy before the first tool call", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any; getArgumentCompletions?: () => Array<{ value: string }> }>();
	const flags = new Map<string, { description: string }>();
	const notices: string[] = [];
	let activeTools = ["read", "bash", "edit", "visualize"];
	let changedMode = "";
	const fakePi = {
		registerTool() {}, registerFlag(name: string, definition: { description: string }) { flags.set(name, definition); }, registerShortcut() {}, registerCommand(name: string, definition: { handler: (...args: any[]) => any; getArgumentCompletions?: () => Array<{ value: string }> }) { commands.set(name, definition); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		events: {
			on() {},
			emit(event: string, value?: { mode?: string }) { if (event === "approval-mode:changed") changedMode = value?.mode || ""; },
		},
		getAllTools() { return ["read", "bash", "edit", "plan", "visualize", "repo_search", "tool_search"].map((name) => ({ name })); },
		getActiveTools() { return activeTools; },
		setActiveTools(value: string[]) { activeTools = value; },
		appendEntry() {}, sendMessage() {}, async exec() { return { stdout: "" }; }, getFlag() { return undefined; },
	};
	approvalModes(fakePi as unknown as ExtensionAPI);
	const context = {
		hasUI: false,
		cwd: "/tmp/legacy-plan-mode-test",
		ui: { theme: { fg: (_color: string, value: string) => value }, setStatus() {}, notify(value: string) { notices.push(value); } },
		sessionManager: {
			getEntries() { return [{ type: "custom", customType: "approval-mode", data: { mode: "plan" } }]; },
			getSessionId() { return "legacy-plan-mode-test"; },
		},
	};
	await handlers.get("session_start")?.({}, context);
	assert.equal(changedMode, "plan");
	assert.match(flags.get("approval-mode")?.description ?? "", /plan/i);
	assert.equal(commands.get("mode")!.getArgumentCompletions!().some((item) => item.value === "plan"), true);
	await commands.get("mode")!.handler("plan", context);
	assert.equal(notices.length, 0);
	assert.equal(activeTools.includes("edit"), false);
	assert.equal(activeTools.includes("plan"), true);
	const callTool = handlers.get("tool_call")!;
	assert.equal(await callTool({ toolName: "plan", toolCallId: "plan", input: {} }, context), undefined);
	assert.equal(await callTool({ toolName: "visualize", toolCallId: "preview", input: { action: "preview", format: "mermaid", source: "graph TD\nA" } }, context), undefined);
	assert.match((await callTool({ toolName: "visualize", toolCallId: "artifact", input: { action: "artifact" } }, context)).reason, /read-only/);
});
