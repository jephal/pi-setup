import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ARTIFACT_BYTES, parseMermaid, mermaidWireframe, buildExcalidrawGraph, serializeExcalidraw } from "./visualization.ts";
import { classifyVisualizationRequest } from "./visualization-request.ts";
import visualization from "./visualization.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const graphNodes = [
	{ id: "api", label: "API" },
	{ id: "db", label: "Database" },
];
const graphEdges = [{ from: "api", to: "db", label: "reads" }];

test("visualization classification keeps previews separate from persistent controls", () => {
	assert.equal(classifyVisualizationRequest({ action: "preview", format: "mermaid", source: "graph TD\\nA" }), "preview-mermaid");
	assert.equal(classifyVisualizationRequest({ action: "preview", format: "excalidraw", nodes: graphNodes }), "preview-excalidraw");
	assert.equal(classifyVisualizationRequest({ action: "preview", format: "excalidraw", target: "plan_board", nodes: graphNodes }), "preview-excalidraw");
	assert.equal(classifyVisualizationRequest({ action: "terminal_viewer", target: "open", format: "excalidraw" }), "terminal-viewer");
	assert.equal(classifyVisualizationRequest({ action: "terminal_viewer", target: "status", format: "excalidraw" }), "terminal-viewer");
	assert.equal(classifyVisualizationRequest({ action: "terminal_viewer", target: "close", format: "excalidraw" }), "terminal-viewer");
	assert.equal(classifyVisualizationRequest({ action: "viewer", target: "terminal_viewer", format: "excalidraw", nodes: graphNodes }), "terminal-viewer");
	assert.equal(classifyVisualizationRequest({ action: "preview", target: "open", format: "excalidraw", nodes: graphNodes }), undefined);
	assert.equal(classifyVisualizationRequest({ action: "preview", target: "plan_board", format: "mermaid", source: "graph TD\nA" }), undefined);
	assert.equal(classifyVisualizationRequest({ action: "artifact", target: "close", format: "excalidraw", nodes: graphNodes, path: "x.excalidraw" }), undefined);
	assert.equal(classifyVisualizationRequest({ action: "terminal_viewer", target: "open", format: "excalidraw" }), "terminal-viewer");
	assert.equal(classifyVisualizationRequest({ action: "viewer", target: "open", format: "excalidraw", nodes: graphNodes }), undefined);
});

test("Mermaid uses the conservative legacy-safe syntax and provides a terminal wireframe", () => {
	const graph = parseMermaid("graph LR\napi[API] --> db[Database]");
	assert.equal(graph.direction, "LR");
	assert.deepEqual(graph.edges, [{ from: "api", to: "db" }]);
	assert.match(mermaidWireframe(graph), /\[api: API\].*\[db: Database\]/);
	for (const source of [
		"graph TD\nA[<script>] --> B[done]",
		"graph TD\nA[one two!] --> B[done]",
		"graph TD\nA[one/two] --> B[done]",
		"graph TD\nA[one\n two] --> B[done]",
		"flowchart TD\nA --> B",
	]) {
		assert.throws(() => parseMermaid(source));
	}
});

test("Excalidraw serialization is deterministic, bounded, and binding-consistent", () => {
	const first = serializeExcalidraw(buildExcalidrawGraph(graphNodes, graphEdges, "System"));
	const second = serializeExcalidraw(buildExcalidrawGraph([...graphNodes].reverse(), [...graphEdges].reverse(), "System"));
	assert.equal(first, second);
	assert.ok(Buffer.byteLength(first, "utf8") <= MAX_ARTIFACT_BYTES);
	const artifact = JSON.parse(first) as { type: string; version: number; elements: Array<Record<string, any>> };
	assert.equal(artifact.type, "excalidraw");
	assert.equal(artifact.version, 2);
	const rectangles = new Map(artifact.elements.filter((element) => element.type === "rectangle").map((element) => [element.id, element]));
	const elements = new Map(artifact.elements.map((element) => [element.id, element]));
	assert.ok(rectangles.size > 0);
	for (const element of artifact.elements) {
		if (element.containerId !== null && element.containerId !== undefined) {
			const container = elements.get(element.containerId);
			assert.ok(container?.type === "rectangle" || container?.type === "arrow");
			assert.ok(container?.boundElements?.some((binding: any) => binding.id === element.id));
		}
		for (const bindingName of ["startBinding", "endBinding"] as const) {
			if (element[bindingName]) {
				assert.equal(rectangles.get(element[bindingName].elementId)?.type, "rectangle");
				assert.ok(rectangles.get(element[bindingName].elementId)?.boundElements?.some((binding: any) => binding.id === element.id));
			}
		}
	}
	for (const rectangle of rectangles.values()) {
		for (const binding of rectangle.boundElements ?? []) assert.equal(elements.get(binding.id)?.type === "text" || elements.get(binding.id)?.type === "arrow", true);
	}
	for (const arrow of artifact.elements.filter((element) => element.type === "arrow")) {
		for (const binding of arrow.boundElements ?? []) {
			assert.equal(elements.get(binding.id)?.type, "text");
			assert.equal(elements.get(binding.id)?.containerId, arrow.id);
		}
	}
	assert.throws(() => serializeExcalidraw({ oversized: "x".repeat(MAX_ARTIFACT_BYTES) }), /artifact exceeds/);
});

test("structured graph ranking follows reversed chains and remains bounded for cycles", () => {
	const nodes = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
	const scene = JSON.parse(serializeExcalidraw(buildExcalidrawGraph(nodes, [{ from: "b", to: "c" }, { from: "a", to: "b" }], undefined, "LR"))) as { elements: Array<Record<string, any>> };
	const boxes = new Map(scene.elements.filter((element) => ["rectangle", "diamond", "ellipse"].includes(element.type)).map((element) => [element.id, element]));
	const xFor = (label: string) => {
		const text = scene.elements.find((element) => element.type === "text" && element.text === label);
		return text?.containerId ? boxes.get(text.containerId)?.x : undefined;
	};
	// Node positions are deterministic and the forward chain must progress left to right.
	assert.ok((xFor("A") ?? 0) < (xFor("B") ?? 0));
	assert.ok((xFor("B") ?? 0) < (xFor("C") ?? 0));
	const cycle = buildExcalidrawGraph(nodes, [{ from: "a", to: "b" }, { from: "b", to: "a" }], undefined, "TD");
	assert.ok(JSON.stringify(cycle).length > 0);
});

test("structured graphs support stable shapes and LR or TD layouts", () => {
	const nodes = [
		{ id: "start", label: "Start", shape: "ellipse" },
		{ id: "check", label: "Check", shape: "diamond" },
		{ id: "done", label: "Done", shape: "rectangle" },
	];
	const lr = JSON.parse(serializeExcalidraw(buildExcalidrawGraph(nodes, [{ from: "start", to: "check" }, { from: "check", to: "done", label: "yes" }], "Flow", "LR"))) as { elements: Array<Record<string, any>> };
	const shapes = new Set(lr.elements.filter((element) => ["rectangle", "diamond", "ellipse"].includes(element.type)).map((element) => element.type));
	assert.deepEqual(shapes, new Set(["rectangle", "diamond", "ellipse"]));
	const boxes = new Map(lr.elements.filter((element) => ["rectangle", "diamond", "ellipse"].includes(element.type)).map((element) => [element.id, element]));
	const ordered = [...boxes.values()].sort((a, b) => a.x - b.x);
	assert.ok(ordered[0].x < ordered.at(-1).x);
	const td = JSON.parse(serializeExcalidraw(buildExcalidrawGraph(nodes, [{ from: "start", to: "check" }], undefined, "TD"))) as { elements: Array<Record<string, any>> };
	assert.notEqual(JSON.stringify(lr), JSON.stringify(td));
});

test("terminal-facing titles and labels reject Markdown fence injection", () => {
	assert.throws(() => buildExcalidrawGraph(graphNodes, [], "Title```"), /backticks/);
	assert.throws(() => buildExcalidrawGraph(graphNodes, [], "Title\nInjected"), /control/);
	assert.throws(() => buildExcalidrawGraph([{ id: "a", label: "bad```" }], [], "Title"), /backticks/);
	assert.throws(() => buildExcalidrawGraph([{ id: "a", label: "bad\nlabel" }], [], "Title"), /control/);
	assert.throws(() => buildExcalidrawGraph(graphNodes, [{ from: "api", to: "db", label: "bad```" }], "Title"), /backticks/);
});

test("viewer action is available in normal execution and its session closes on shutdown", async () => {
	const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const fakePi = {
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		events: { on(name: string, handler: (...args: any[]) => any) { if (name === "approval-mode:changed") handlers.set(name, handler); } },
	};
	visualization(fakePi as unknown as ExtensionAPI);
	const tool = definitions.find((definition) => definition.name === "visualize")!;
	const result = await tool.execute("viewer", { action: "viewer", format: "excalidraw", nodes: graphNodes, edges: graphEdges }, undefined, undefined, { cwd: process.cwd() });
	assert.equal(result.details.status, "ready");
	assert.match(result.content[0].text, /http:\/\/127\.0\.0\.1:/);
	const page = await fetch(result.details.url);
	assert.equal(page.status, 200);
	const html = await page.text();
	const assetPaths = [...html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)].map((match) => match[1]);
	assert.ok(assetPaths.some((path) => path.endsWith(".js")));
	assert.ok(assetPaths.some((path) => path.endsWith(".css")));
	for (const path of assetPaths) {
		const asset = await fetch(new URL(path, result.details.url), { headers: { cookie: page.headers.get("set-cookie")?.split(";", 1)[0] || "" } });
		assert.equal(asset.status, 200, path);
	}
	handlers.get("approval-mode:changed")?.({ mode: "review" });
	const reviewWrite = await fetch(new URL("/api/scene", result.details.url), {
		method: "PUT",
		headers: { "content-type": "application/json", cookie: page.headers.get("set-cookie")?.split(";", 1)[0] || "" },
		body: JSON.stringify({ revision: result.details.revision, scene: buildExcalidrawGraph(graphNodes, graphEdges) }),
	});
	assert.equal(reviewWrite.status, 403);
	await handlers.get("session_shutdown")?.();
	await assert.rejects(fetch(result.details.url));
});

test("terminal viewer status and close do not require graph input", async () => {
	const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const fakePi = {
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
		events: { on() {} },
	};
	visualization(fakePi as unknown as ExtensionAPI);
	const tool = definitions.find((definition) => definition.name === "visualize")!;
	const context = { cwd: process.cwd() };
	const status = await tool.execute("terminal-status-no-graph", { action: "terminal_viewer", format: "excalidraw", target: "status" }, undefined, undefined, context);
	assert.equal(status.details.status, "closed");
	const closed = await tool.execute("terminal-close-no-graph", { action: "terminal_viewer", format: "excalidraw", target: "close" }, undefined, undefined, context);
	assert.equal(closed.details.status, "closed");
});

test("terminal viewer opens, updates, and closes through its private control socket", async () => {
	const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const fakePi = {
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		events: { on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); } },
	};
	visualization(fakePi as unknown as ExtensionAPI);
	const tool = definitions.find((definition) => definition.name === "visualize")!;
	const context = { cwd: process.cwd() };
	const opened = await tool.execute("terminal-open", { action: "terminal_viewer", format: "excalidraw", target: "open", nodes: graphNodes }, undefined, undefined, context);
	assert.equal(opened.details.role, "visualization-viewer");
	assert.equal(opened.details.revision, 1);
	assert.ok(opened.details.paneId);
	assert.doesNotMatch(opened.content[0].text, /Structured graph|Terminal controls/);
	const reopened = await tool.execute("terminal-reopen", { action: "terminal_viewer", format: "excalidraw", target: "open", nodes: graphNodes }, undefined, undefined, context);
	assert.equal(reopened.details.paneId, opened.details.paneId);
	assert.equal(reopened.details.revision, 2);
	const status = await tool.execute("terminal-status", { action: "terminal_viewer", format: "excalidraw", target: "status" }, undefined, undefined, context);
	assert.equal(status.details.status, "ready");
	assert.equal(status.details.paneId, opened.details.paneId);
	const updated = await tool.execute("terminal-update", { action: "terminal_viewer", format: "excalidraw", target: "update", nodes: [{ id: "api", label: "Updated" }] }, undefined, undefined, context);
	assert.equal(updated.details.revision, 3);
	assert.equal(updated.details.paneId, opened.details.paneId);
	assert.doesNotMatch(updated.content[0].text, /Structured graph|Terminal controls/);
	const closed = await tool.execute("terminal-close", { action: "terminal_viewer", format: "excalidraw", target: "close" }, undefined, undefined, context);
	assert.equal(closed.details.status, "closed");
	assert.equal(closed.details.paneId, opened.details.paneId);
	await handlers.get("session_shutdown")?.();
});

test("Herdr close during reload is safe when no local terminal viewer exists", async () => {
	const previousHerdrEnv = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	try {
		const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
		const emitted: string[] = [];
		const fakePi = {
			registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
			events: {
				on() {},
				emit(name: string, value: { respond?: (result: { ok: boolean }) => void }) {
					emitted.push(name);
					if (name === "herdr:close-terminal-viewer") value.respond?.({ ok: true });
				},
			},
		};
		visualization(fakePi as unknown as ExtensionAPI);
		const tool = definitions.find((definition) => definition.name === "visualize")!;
		const result = await tool.execute("close-empty-terminal-viewer", { action: "terminal_viewer", target: "close", format: "excalidraw" }, undefined, undefined, { cwd: process.cwd() });
		assert.equal(result.details.status, "closed");
		assert.ok(emitted.includes("herdr:close-terminal-viewer"));
	} finally {
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
	}
});

test("Review mode allows the browser viewer but keeps it read-only", async () => {
	const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const fakePi = {
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		events: { on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); } },
	};
	visualization(fakePi as unknown as ExtensionAPI);
	const tool = definitions.find((definition) => definition.name === "visualize")!;
	handlers.get("approval-mode:changed")?.({ mode: "review" });
	const result = await tool.execute("review-browser", { action: "viewer", format: "excalidraw", nodes: graphNodes }, undefined, undefined, { cwd: process.cwd() });
	assert.equal(result.details.status, "ready");
	const page = await fetch(result.details.url);
	const cookie = page.headers.get("set-cookie")?.split(";", 1)[0] || "";
	const write = await fetch(new URL("/api/scene", result.details.url), {
		method: "PUT", headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ revision: result.details.revision, scene: buildExcalidrawGraph(graphNodes, graphEdges) }),
	});
	assert.equal(write.status, 403);
	handlers.get("approval-mode:changed")?.({ mode: "plan" });
	const planWrite = await fetch(new URL("/api/scene", result.details.url), {
		method: "PUT", headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ revision: result.details.revision, scene: buildExcalidrawGraph(graphNodes, graphEdges) }),
	});
	assert.equal(planWrite.status, 403);
	await assert.rejects(tool.execute("plan-viewer", { action: "viewer", format: "excalidraw", nodes: graphNodes }, undefined, undefined, { cwd: process.cwd() }), /Plan mode/);
	await assert.rejects(tool.execute("plan-artifact", { action: "artifact", format: "excalidraw", nodes: graphNodes, path: "plan.excalidraw" }, undefined, undefined, { cwd: process.cwd() }), /Plan mode/);
	await handlers.get("session_shutdown")?.();
});

test("terminal viewer and artifact writes are blocked in Plan and Review modes", async () => {
	for (const mode of ["plan", "review"]) {
		const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
		const handlers = new Map<string, (...args: any[]) => any>();
		const fakePi = {
			registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
			events: { on(name: string, handler: (...args: any[]) => any) { if (name === "approval-mode:changed") handlers.set(name, handler); } },
		};
		visualization(fakePi as unknown as ExtensionAPI);
		const tool = definitions.find((definition) => definition.name === "visualize")!;
		handlers.get("approval-mode:changed")?.({ mode });
		const expectedMode = mode === "plan" ? /Plan mode/ : /Review mode/;
		await assert.rejects(tool.execute("blocked", { action: "terminal_viewer", target: "open", format: "excalidraw", nodes: graphNodes }, undefined, undefined, { cwd: process.cwd() }), expectedMode);
		await assert.rejects(tool.execute("blocked-artifact", { action: "artifact", format: "excalidraw", nodes: graphNodes, path: "blocked.excalidraw" }, undefined, undefined, { cwd: process.cwd() }), expectedMode);
	}
});

test("approve and manual modes still allow viewer and artifact execution", async () => {
	for (const mode of ["approve", "manual"]) {
		const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
		const handlers = new Map<string, (...args: any[]) => any>();
		const fakePi = {
			registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			events: { on(name: string, handler: (...args: any[]) => any) { if (name === "approval-mode:changed") handlers.set(name, handler); } },
		};
		visualization(fakePi as unknown as ExtensionAPI);
		const tool = definitions.find((definition) => definition.name === "visualize")!;
		handlers.get("approval-mode:changed")?.({ mode });
		const viewerResult = await tool.execute("viewer", { action: "viewer", format: "excalidraw", nodes: graphNodes }, undefined, undefined, { cwd: process.cwd() });
		assert.equal(viewerResult.details.status, "ready", mode);
		await handlers.get("session_shutdown")?.();
		const root = await mkdtemp(join(tmpdir(), `pi-visualization-${mode}-`));
		const artifact = await tool.execute("artifact", { action: "artifact", format: "excalidraw", nodes: graphNodes, path: "graph.excalidraw" }, undefined, undefined, { cwd: root });
		assert.match(artifact.content[0].text, /Wrote Excalidraw artifact/);
	}
});

test("visualize validates combinations and writes isolated explicit artifacts safely", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-visualization-"));
	const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const fakePi = {
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) { definitions.push(definition); },
	};
	visualization(fakePi as unknown as ExtensionAPI);
	const tool = definitions.find((definition) => definition.name === "visualize")!;
	const context = { cwd: root };
	const preview = await tool.execute("preview", { action: "preview", format: "mermaid", source: "graph TD\nA --> B", title: "System" }, undefined, undefined, context);
	assert.match(preview.content[0].text, /```mermaid/);
	assert.match(preview.content[0].text, /Terminal wireframe fallback/);
	for (const title of ["bad```", "bad\nInjected"]) {
		await assert.rejects(tool.execute("unsafe-title", { action: "preview", format: "mermaid", source: "graph TD\nA", title }, undefined, undefined, context));
	}
	for (const params of [
		{ action: "preview", format: "mermaid" },
		{ action: "preview", format: "excalidraw" },
		{ action: "preview", format: "excalidraw", target: "open", nodes: graphNodes },
		{ action: "viewer", format: "excalidraw", target: "open", nodes: graphNodes },
		{ action: "viewer", format: "excalidraw", target: "status", nodes: graphNodes },
		{ action: "terminal_viewer", format: "excalidraw", target: "open" },
		{ action: "terminal_viewer", format: "excalidraw", target: "update" },
		{ action: "terminal_viewer", format: "excalidraw", target: "status", nodes: graphNodes },
		{ action: "artifact", format: "mermaid", source: "graph TD\nA" },
		{ action: "artifact", format: "excalidraw", nodes: graphNodes, edges: graphEdges },
		{ action: "artifact", target: "close", format: "excalidraw", nodes: graphNodes, path: "x.excalidraw" },
	]) {
		await assert.rejects(tool.execute("invalid", params, undefined, undefined, context));
	}

	const artifactPath = "artifacts/graph.excalidraw";
	const artifact = await tool.execute("artifact", { action: "artifact", format: "excalidraw", nodes: graphNodes, edges: graphEdges, path: artifactPath }, undefined, undefined, context);
	assert.match(artifact.content[0].text, /artifacts\/graph\.excalidraw/);
	assert.equal(JSON.parse(await readFile(join(root, artifactPath), "utf8")).type, "excalidraw");
	await writeFile(join(root, artifactPath), "old content", "utf8");
	await tool.execute("artifact", { action: "artifact", format: "excalidraw", nodes: graphNodes, edges: graphEdges, path: artifactPath }, undefined, undefined, context);
	assert.equal(JSON.parse(await readFile(join(root, artifactPath), "utf8")).type, "excalidraw");

	const outside = await mkdtemp(join(tmpdir(), "pi-visualization-outside-"));
	await mkdir(join(root, "existing"));
	await symlink(outside, join(root, "linked-parent"));
	await writeFile(join(outside, "target.excalidraw"), "outside", "utf8");
	await symlink(join(outside, "target.excalidraw"), join(root, "linked-target.excalidraw"));
	for (const path of ["../outside.excalidraw", "/tmp/outside.excalidraw", "C:\\outside.excalidraw", "existing", "linked-parent/graph.excalidraw", "linked-target.excalidraw"]) {
		await assert.rejects(
			tool.execute("unsafe", { action: "artifact", format: "excalidraw", nodes: graphNodes, edges: graphEdges, path }, undefined, undefined, context),
		);
	}
});
