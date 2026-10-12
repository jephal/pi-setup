import assert from "node:assert/strict";
import test from "node:test";
import { isPlanModeToolAllowed, isPlanModeVisualizationAllowed, isReviewModeToolAllowed, isReviewModeVisualizationAllowed, isSafePlanBash, PLAN_TOOLS, readOnlyToolNames, restoreActiveTools, REVIEW_TOOLS } from "./approval-tools.ts";
import approvalModes from "./approval-modes.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("Plan mode bash safety rejects mutating Git commands and shell composition", () => {
	assert.equal(isSafePlanBash("git status --short"), true);
	assert.equal(isSafePlanBash("git branch -D feature"), false);
	assert.equal(isSafePlanBash("git remote add origin https://example.test"), false);
	assert.equal(isSafePlanBash("git status && rm -rf ."), false);
	assert.equal(isSafePlanBash("git rev-parse --show-toplevel"), true);
});

test("Plan and Review modes keep context tools while filtering visual side effects", () => {
	for (const tool of ["notes_list", "notes_read", "fovea_focus", "datadog_search_tools", "scheduled_task_list", "repo_search"]) {
		assert.equal(PLAN_TOOLS.has(tool), true, tool);
	}
	for (const tool of ["notes_write", "notes_transfer", "notes_save", "notes_git", "memory", "herdr_shell", "scheduled_task_create", "scheduled_task_delete", "scheduled_task_run_now"]) {
		assert.equal(PLAN_TOOLS.has(tool), false, tool);
	}
	assert.equal(REVIEW_TOOLS.has("notes_list"), false);
	assert.equal(REVIEW_TOOLS.has("repo_search"), true);
	assert.equal(REVIEW_TOOLS.has("visualize"), true);
	assert.equal(REVIEW_TOOLS.has("plan_board"), true);
	assert.equal(PLAN_TOOLS.has("plan_board"), true);
	assert.equal(isPlanModeToolAllowed("datadog_logs"), true);
	assert.equal(isPlanModeToolAllowed("datadog_create_monitor"), false);
	assert.equal(isPlanModeToolAllowed("write"), false);
	assert.equal(isPlanModeVisualizationAllowed({ action: "preview", format: "mermaid", source: "graph TD\nA" }), true);
	assert.equal(isReviewModeVisualizationAllowed({ action: "preview", format: "mermaid", source: "graph TD\nA" }), true);
	assert.equal(isReviewModeVisualizationAllowed({ action: "viewer", format: "excalidraw", nodes: [{ id: "a", label: "A" }] }), true);
	assert.equal(isReviewModeVisualizationAllowed({ action: "viewer", target: "terminal_viewer", format: "excalidraw", nodes: [{ id: "a", label: "A" }] }), false);
	assert.equal(isReviewModeVisualizationAllowed({ action: "artifact", format: "excalidraw", nodes: [{ id: "a", label: "A" }], path: "a.excalidraw" }), false);
	assert.equal(isPlanModeVisualizationAllowed({ action: "preview", format: "excalidraw", nodes: [{ id: "a", label: "A" }] }), true);
	assert.equal(isPlanModeVisualizationAllowed({ action: "preview", format: "excalidraw", target: "plan_board", nodes: [{ id: "a", label: "A" }] }), true);
	assert.equal(isPlanModeVisualizationAllowed({ action: "preview", format: "excalidraw", target: "close", nodes: [{ id: "a", label: "A" }] }), false);
	assert.equal(isPlanModeVisualizationAllowed({ action: "preview", format: "mermaid", target: "terminal_viewer", source: "graph TD\nA" }), false);
	assert.equal(isPlanModeVisualizationAllowed({ action: "artifact" }), false);
	assert.equal(isPlanModeVisualizationAllowed(undefined), false);
	assert.equal(isPlanModeVisualizationAllowed(null), false);
	assert.equal(isPlanModeVisualizationAllowed({}), false);
	assert.equal(isPlanModeToolAllowed("visualize", { action: "preview", format: "mermaid", source: "graph TD\nA" }), true);
	assert.equal(isPlanModeToolAllowed("visualize", { action: "artifact" }), false);
	assert.equal(isReviewModeToolAllowed("visualize", { action: "viewer", format: "excalidraw", nodes: [{ id: "a", label: "A" }] }), true);
	assert.equal(isReviewModeToolAllowed("visualize", { action: "artifact" }), false);
	assert.equal(isPlanModeToolAllowed("visualize"), false);
	const available = ["read", "plan", "repo_search", "visualize", "notes_list", "memory", "fovea_focus", "datadog_logs"];
	assert.deepEqual(readOnlyToolNames("review", available), ["read", "plan", "repo_search", "visualize"]);
	assert.deepEqual(readOnlyToolNames("plan", available), ["read", "plan", "repo_search", "visualize", "notes_list", "fovea_focus"]);
});

test("leaving read-only mode preserves dynamically activated tools", () => {
	assert.deepEqual(
		restoreActiveTools(
			["read", "notes_admin_tools", "datadog_search_tools"],
			["read", "grep", "plan", "notes_list", "datadog_logs", "notes_list"],
		),
		["read", "notes_admin_tools", "datadog_search_tools", "notes_list", "datadog_logs"],
	);
	assert.deepEqual(
		restoreActiveTools(
			["read"],
			["read", "notes_list", "fovea_focus", "datadog_logs"],
			PLAN_TOOLS,
		),
		["read", "datadog_logs"],
	);
});

test("session start restores persisted Plan mode before the first tool call", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let activeTools = ["read", "visualize"];
	let changedMode = "";
	const fakePi = {
		registerTool() {}, registerFlag() {}, registerShortcut() {}, registerCommand() {},
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		events: { on() {}, emit(event: string, value: { mode?: string }) { if (event === "approval-mode:changed") changedMode = value.mode || ""; } },
		getAllTools() { return [{ name: "read" }, { name: "plan" }, { name: "visualize" }]; },
		getActiveTools() { return activeTools; }, setActiveTools(value: string[]) { activeTools = value; },
		appendEntry() {}, sendMessage() {}, async exec() { return { stdout: "" }; }, getFlag() { return undefined; },
	};
	approvalModes(fakePi as unknown as ExtensionAPI);
	const context = {
		hasUI: false, cwd: process.cwd(),
		ui: { theme: { fg: (_color: string, value: string) => value }, setStatus() {}, notify() {} },
		sessionManager: { getEntries() { return [{ type: "custom", customType: "approval-mode", data: { mode: "plan" } }]; }, getSessionId() { return "persisted-plan-test"; } },
	} as any;
	await handlers.get("session_start")?.({}, context);
	assert.equal(changedMode, "plan");
	assert.equal(activeTools.includes("visualize"), true);
	const result = await handlers.get("tool_call")?.({ toolName: "visualize", toolCallId: "artifact", input: { action: "artifact" } }, context);
	assert.match(result.reason, /read-only/);
});

test("registered Plan tool_call policy permits previews and blocks visualization artifacts", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	let activeTools = ["read"];
	const fakePi = {
		registerTool() {}, registerFlag() {}, registerShortcut() {},
		registerCommand(name: string, definition: { handler: (...args: any[]) => any }) { commands.set(name, definition); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		events: { on() {}, emit() {} },
		getAllTools() { return [{ name: "read" }, { name: "plan" }, { name: "visualize" }]; },
		getActiveTools() { return activeTools; }, setActiveTools(value: string[]) { activeTools = value; },
		appendEntry() {}, sendMessage() {}, getFlag() { return "auto"; },
	};
	approvalModes(fakePi as unknown as ExtensionAPI);
	const context = { hasUI: false, ui: { theme: { fg: (_color: string, value: string) => value }, setStatus() {}, notify() {} } } as any;
	await commands.get("mode")!.handler("plan", context);
	assert.equal(activeTools.includes("visualize"), true);
	const toolCall = handlers.get("tool_call")!;
	assert.equal(await toolCall({ toolName: "visualize", toolCallId: "preview", input: { action: "preview", format: "mermaid", source: "graph TD\nA" } }, context), undefined);
	assert.match((await toolCall({ toolName: "visualize", toolCallId: "artifact", input: { action: "artifact" } }, context)).reason, /read-only/);
	assert.match((await toolCall({ toolName: "visualize", toolCallId: "missing", input: {} }, context)).reason, /read-only/);
	assert.match((await toolCall({ toolName: "visualize", toolCallId: "null", input: null }, context)).reason, /read-only/);
});
