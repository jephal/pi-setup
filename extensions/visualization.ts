import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { render as renderMermaid } from "grok-mermaid";
import { Type } from "typebox";
import { startExcalidrawViewer, type ViewerSession } from "./excalidraw-viewer-server.ts";
import { createTerminalViewerEndpoint, sendTerminalViewerCommand, spawnLocalTerminalViewer, type TerminalViewerEndpoint } from "./excalidraw-terminal-viewer.ts";
import { terminalDisplayWidth } from "./excalidraw-terminal-renderer.ts";
import { classifyVisualizationRequest, isPreviewVisualizationRequest } from "./visualization-request.ts";

const MAX_MERMAID_CHARS = 8_000;
const MAX_MERMAID_LINES = 80;
const MAX_MERMAID_LINE_CHARS = 240;
const MAX_GRAPH_NODES = 50;
const MAX_GRAPH_EDGES = 100;
const MAX_LABEL_CHARS = 120;
const MAX_ARTIFACT_PATH_CHARS = 200;
const MAX_WIREFRAME_CHARS = 6_000;
export const MAX_ARTIFACT_BYTES = 256_000;
const MAX_OUTPUT_BYTES = 32_000;
const MAX_WIREFRAME_BYTES = 24_000;

const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_MERMAID_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,119}$/;

export type VisualizationAction = "preview" | "viewer" | "terminal_viewer" | "artifact";
export type VisualizationFormat = "mermaid" | "excalidraw";

export interface GraphNodeInput {
	id: string;
	label: string;
	shape?: "rectangle" | "diamond" | "ellipse";
}

export interface GraphEdgeInput {
	from: string;
	to: string;
	label?: string;
}

interface ParsedMermaidGraph {
	direction: "TD" | "LR";
	nodes: Map<string, string>;
	edges: Array<{ from: string; to: string }>;
}

const graphNodeSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 32, description: "Simple node ID, such as api or database" }),
	label: Type.String({ minLength: 1, maxLength: MAX_LABEL_CHARS, description: "Plain text shown inside the node" }),
	shape: Type.Optional(Type.Union([Type.Literal("rectangle"), Type.Literal("diamond"), Type.Literal("ellipse")], { description: "Node shape; defaults to rectangle" })),
});

const graphEdgeSchema = Type.Object({
	from: Type.String({ minLength: 1, maxLength: 32, description: "Source node ID" }),
	to: Type.String({ minLength: 1, maxLength: 32, description: "Target node ID" }),
	label: Type.Optional(Type.String({ maxLength: 80, description: "Optional plain text edge label" })),
});

/** Keep the model-facing schema explicit: each action/format has only valid inputs. */
const titleSchema = Type.Optional(Type.String({ maxLength: 120, description: "Short plain-text title" }));
const directionSchema = Type.Optional(Type.Union([Type.Literal("LR"), Type.Literal("TD")], { description: "Deterministic graph direction; defaults to TD" }));
const sourceSchema = Type.String({ maxLength: MAX_MERMAID_CHARS, description: "Conservative Mermaid graph source for a Mermaid preview" });
const nodesSchema = Type.Array(graphNodeSchema, { minItems: 1, maxItems: MAX_GRAPH_NODES, description: "Nodes for an Excalidraw graph" });
const edgesSchema = Type.Optional(Type.Array(graphEdgeSchema, { maxItems: MAX_GRAPH_EDGES, description: "Directed edges between node IDs" }));
const pathSchema = Type.String({ maxLength: MAX_ARTIFACT_PATH_CHARS, description: "Explicit project-relative .excalidraw path" });
const terminalViewerGraphSchema = Type.Object({ action: Type.Literal("terminal_viewer"), format: Type.Literal("excalidraw"), target: Type.Union([Type.Literal("open"), Type.Literal("update")]), title: titleSchema, direction: directionSchema, nodes: nodesSchema, edges: edgesSchema });
const terminalViewerControlSchema = Type.Union([
	Type.Object({ action: Type.Literal("terminal_viewer"), format: Type.Literal("excalidraw"), target: Type.Literal("status"), title: titleSchema }),
	Type.Object({ action: Type.Literal("terminal_viewer"), format: Type.Literal("excalidraw"), target: Type.Literal("close"), title: titleSchema }),
]);
export const visualizeParameters = Type.Union([
	Type.Object({ action: Type.Literal("preview"), format: Type.Literal("mermaid"), title: titleSchema, source: sourceSchema }),
	Type.Object({ action: Type.Literal("preview"), format: Type.Literal("excalidraw"), target: Type.Optional(Type.Literal("plan_board")), title: titleSchema, direction: directionSchema, nodes: nodesSchema, edges: edgesSchema }),
	Type.Object({ action: Type.Literal("viewer"), format: Type.Literal("excalidraw"), title: titleSchema, direction: directionSchema, nodes: nodesSchema, edges: edgesSchema }),
	Type.Object({ action: Type.Literal("viewer"), target: Type.Literal("terminal_viewer"), format: Type.Literal("excalidraw"), title: titleSchema, direction: directionSchema, nodes: nodesSchema, edges: edgesSchema }),
	terminalViewerGraphSchema,
	terminalViewerControlSchema,
	Type.Object({ action: Type.Literal("artifact"), format: Type.Literal("excalidraw"), title: titleSchema, direction: directionSchema, nodes: nodesSchema, edges: edgesSchema, path: pathSchema }),
]);

function text(value: unknown, field: string, max: number, required = true, allowNewlines = false, allowMarkup = false): string {
	if (typeof value !== "string") {
		if (!required && value === undefined) return "";
		throw new Error(`${field} must be text.`);
	}
	const result = value.trim();
	if (required && !result) throw new Error(`${field} is required.`);
	if (result.length > max) throw new Error(`${field} is limited to ${max} characters.`);
	const controlPattern = allowNewlines ? /\0|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /\0|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\n\r]/;
	if (controlPattern.test(result)) throw new Error(`${field} contains unsupported control characters.`);
	if (!allowMarkup && (/[<>`]/.test(result) || /\bjavascript\s*:/i.test(result))) throw new Error(`${field} cannot contain HTML, backticks, or executable URLs.`);
	return result;
}

function parseMermaidNode(value: string): { id: string; label: string } {
	const match = value.trim().match(/^([A-Za-z][A-Za-z0-9_-]{0,31})(?:\[([^\[\]\r\n]{1,120})\])?$/);
	if (!match) throw new Error("Mermaid nodes must use simple IDs with optional plain labels, such as api[API].");
	const id = match[1];
	const label = match[2]?.trim() || id;
	if (!NODE_ID.test(id) || !label) throw new Error("Mermaid node IDs and labels are invalid.");
	if (!SAFE_MERMAID_LABEL.test(label)) throw new Error("Mermaid labels must use letters, numbers, spaces, _ or - only.");
	return { id, label };
}

/**
 * Validate the intentionally small Mermaid subset that can safely be placed in
 * a Markdown fence. Pi renders this ordinary Markdown with its own Mermaid
 * transformer; this extension does not duplicate that renderer.
 */
export function parseMermaid(source: unknown): ParsedMermaidGraph & { source: string } {
	const normalized = text(source, "source", MAX_MERMAID_CHARS, true, true, true);
	if (/\bjavascript\s*:/i.test(normalized) || /`/.test(normalized)) throw new Error("source cannot contain executable URLs or Markdown fence characters.");
	if (Buffer.byteLength(normalized, "utf8") > MAX_MERMAID_CHARS) throw new Error(`source is limited to ${MAX_MERMAID_CHARS} UTF-8 bytes.`);
	const lines = normalized.replaceAll("\r\n", "\n").split("\n");
	if (lines.length > MAX_MERMAID_LINES) throw new Error(`Mermaid source is limited to ${MAX_MERMAID_LINES} lines.`);
	if (!/^graph\s+(TD|LR)\s*$/i.test(lines[0]?.trim() || "")) throw new Error("Mermaid must start with `graph TD` or `graph LR`.");

	const direction = lines[0].trim().slice(-2).toUpperCase() as "TD" | "LR";
	const nodes = new Map<string, string>();
	const edges: Array<{ from: string; to: string }> = [];
	for (const rawLine of lines.slice(1)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (rawLine.length > MAX_MERMAID_LINE_CHARS) throw new Error(`Each Mermaid line is limited to ${MAX_MERMAID_LINE_CHARS} characters.`);
		const edge = line.match(/^(.+?)\s+-->\s+(.+)$/);
		if (edge) {
			const from = parseMermaidNode(edge[1]);
			const to = parseMermaidNode(edge[2]);
			nodes.set(from.id, from.label);
			nodes.set(to.id, to.label);
			edges.push({ from: from.id, to: to.id });
			continue;
		}
		const node = parseMermaidNode(line);
		nodes.set(node.id, node.label);
	}
	if (nodes.size === 0) throw new Error("Mermaid must contain at least one node.");
	if (nodes.size > MAX_GRAPH_NODES) throw new Error(`Mermaid is limited to ${MAX_GRAPH_NODES} nodes.`);
	if (edges.length > MAX_GRAPH_EDGES) throw new Error(`Mermaid is limited to ${MAX_GRAPH_EDGES} edges.`);
	return { direction, nodes, edges, source: lines.join("\n") };
}

function bounded(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function boundedUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = "";
	for (const character of value) {
		const candidate = `${result}${character}…`;
		if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
		result += character;
	}
	return `${result}…`;
}

function outputText(value: string, field: string, maxBytes: number): string {
	const result = boundedUtf8(value, maxBytes);
	if (Buffer.byteLength(result, "utf8") > maxBytes) throw new Error(`${field} exceeds ${maxBytes} UTF-8 bytes.`);
	return result;
}

export function mermaidWireframe(graph: ParsedMermaidGraph): string {
	const lines: string[] = [`Direction: ${graph.direction === "LR" ? "left to right" : "top down"}`];
	for (const edge of graph.edges) {
		const from = bounded(`${edge.from}: ${graph.nodes.get(edge.from) || edge.from}`, 100);
		const to = bounded(`${edge.to}: ${graph.nodes.get(edge.to) || edge.to}`, 100);
		lines.push(`[${from}] ──▶ [${to}]`);
	}
	const connected = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
	for (const [id, label] of graph.nodes) {
		if (!connected.has(id)) lines.push(`[${bounded(`${id}: ${label}`, 100)}]`);
	}
	return outputText(bounded(lines.join("\n"), MAX_WIREFRAME_CHARS), "wireframe", MAX_WIREFRAME_BYTES);
}

function validateGraph(nodesValue: unknown, edgesValue: unknown): { nodes: GraphNodeInput[]; edges: GraphEdgeInput[] } {
	if (!Array.isArray(nodesValue) || nodesValue.length < 1 || nodesValue.length > MAX_GRAPH_NODES) {
		throw new Error(`Excalidraw graphs require 1-${MAX_GRAPH_NODES} nodes.`);
	}
	if (edgesValue !== undefined && (!Array.isArray(edgesValue) || edgesValue.length > MAX_GRAPH_EDGES)) {
		throw new Error(`Excalidraw graphs are limited to ${MAX_GRAPH_EDGES} edges.`);
	}
	const nodes: GraphNodeInput[] = [];
	const ids = new Set<string>();
	for (const value of nodesValue) {
		if (!value || typeof value !== "object") throw new Error("Each graph node must be an object.");
		const record = value as Record<string, unknown>;
		const id = text(record.id, "node id", 32);
		const label = text(record.label, `label for ${id}`, MAX_LABEL_CHARS);
		const shape = record.shape === undefined ? undefined : record.shape;
		if (shape !== undefined && shape !== "rectangle" && shape !== "diamond" && shape !== "ellipse") throw new Error(`Shape for ${id} must be rectangle, diamond, or ellipse.`);
		if (!NODE_ID.test(id)) throw new Error(`Node ID ${JSON.stringify(id)} must start with a letter and contain only letters, numbers, _ or -.`);
		if (ids.has(id)) throw new Error(`Duplicate node ID: ${id}.`);
		ids.add(id);
		nodes.push(shape ? { id, label, shape } : { id, label });
	}
	const edges: GraphEdgeInput[] = [];
	const edgeKeys = new Set<string>();
	for (const value of (edgesValue as unknown[] | undefined) ?? []) {
		if (!value || typeof value !== "object") throw new Error("Each graph edge must be an object.");
		const record = value as Record<string, unknown>;
		const from = text(record.from, "edge source", 32);
		const to = text(record.to, "edge target", 32);
		if (!ids.has(from) || !ids.has(to)) throw new Error(`Edge ${from} -> ${to} references an unknown node.`);
		const label = record.label === undefined ? undefined : text(record.label, "edge label", 80, false);
		const key = `${from}\u0000${to}\u0000${label ?? ""}`;
		if (edgeKeys.has(key)) throw new Error(`Duplicate edge: ${from} -> ${to}.`);
		edgeKeys.add(key);
		edges.push(label ? { from, to, label } : { from, to });
	}
	return { nodes, edges };
}

function hashNumber(value: string): number {
	return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16) % 2_000_000_000;
}

function elementId(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function commonElement(id: string, type: string, x: number, y: number, width: number, height: number) {
	return {
		type,
		version: 1,
		versionNonce: hashNumber(`${id}:nonce`),
		isDeleted: false,
		id,
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 0,
		opacity: 100,
		angle: 0,
		x,
		y,
		strokeColor: "#1e1e1e",
		backgroundColor: "#ffffff",
		width,
		height,
		seed: hashNumber(`${id}:seed`),
		groupIds: [],
		frameId: null,
		boundElements: null,
		updated: 0,
		link: null,
		locked: false,
		roundness: { type: 3 },
	};
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stableValue(entry)]));
}

/** Build a deterministic, portable Excalidraw graph without timestamps or random IDs. */
export function buildExcalidrawGraph(nodesValue: unknown, edgesValue: unknown, titleValue?: unknown, directionValue?: unknown) {
	const { nodes, edges } = validateGraph(nodesValue, edgesValue);
	const title = titleValue === undefined ? "" : text(titleValue, "title", 120, false);
	const direction = directionValue === undefined ? "TD" : directionValue;
	if (direction !== "LR" && direction !== "TD") throw new Error("direction must be LR or TD.");
	const orderedNodes = [...nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const orderedEdges = [...edges].sort((a, b) => {
		const left = `${a.from}\u0000${a.to}\u0000${a.label ?? ""}`;
		const right = `${b.from}\u0000${b.to}\u0000${b.label ?? ""}`;
		return left < right ? -1 : left > right ? 1 : 0;
	});
	const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
	const ranks = new Map(orderedNodes.map((node) => [node.id, 0]));
	// Repeated bounded relaxation handles reverse-named edge chains while
	// remaining deterministic and dependency-free. Cycles stop at the rank cap.
	for (let pass = 0; pass < orderedNodes.length; pass++) {
		for (const edge of orderedEdges) {
			const next = Math.min(orderedNodes.length - 1, (ranks.get(edge.from) ?? 0) + 1);
			if (next > (ranks.get(edge.to) ?? 0)) ranks.set(edge.to, next);
		}
	}
	const groups = new Map<number, GraphNodeInput[]>();
	for (const node of orderedNodes) groups.set(ranks.get(node.id) ?? 0, [...(groups.get(ranks.get(node.id) ?? 0) ?? []), node]);
	for (const group of groups.values()) group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	for (const [rank, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
		for (const [index, node] of group.entries()) {
			const width = Math.max(180, Math.min(360, 80 + terminalDisplayWidth(node.label) * 8));
			const x = direction === "LR" ? 80 + rank * 340 : 80 + index * 300;
			const y = direction === "LR" ? 80 + index * 160 : 80 + rank * 160;
			positions.set(node.id, { x, y, width, height: 80 });
		}
	}

	const elements: Record<string, unknown>[] = [];
	const boxIds = new Map(orderedNodes.map((node) => [node.id, elementId(`node:${node.id}:box`)]));
	const textIds = new Map(orderedNodes.map((node) => [node.id, elementId(`node:${node.id}:text`)]));
	const boundArrowIds = new Map<string, string[]>();
	for (const edge of orderedEdges) {
		const arrowId = elementId(`edge:${edge.from}:${edge.to}:${edge.label ?? ""}`);
		for (const nodeId of new Set([edge.from, edge.to])) {
			boundArrowIds.set(nodeId, [...(boundArrowIds.get(nodeId) ?? []), arrowId]);
		}
	}
	for (const edge of orderedEdges) {
		const from = positions.get(edge.from)!;
		const to = positions.get(edge.to)!;
		const horizontal = direction === "LR";
		const startX = horizontal ? from.x + from.width : from.x + from.width / 2;
		const startY = horizontal ? from.y + from.height / 2 : from.y + from.height;
		let points: number[][];
		let elementX = startX;
		let elementY = startY;
		let width: number;
		let height: number;
		if (edge.from === edge.to) {
			points = horizontal ? [[0, 0], [60, 0], [60, 80], [0, 80]] : [[0, 0], [60, 0], [60, 80], [0, 80]];
			width = 60;
			height = 80;
		} else {
			const endX = horizontal ? to.x : to.x + to.width / 2;
			const endY = horizontal ? to.y + to.height / 2 : to.y;
			const deltaX = endX - startX;
			const deltaY = endY - startY;
			elementX = Math.min(startX, endX);
			elementY = Math.min(startY, endY);
			points = [[startX - elementX, startY - elementY], [endX - elementX, endY - elementY]];
			width = Math.abs(deltaX);
			height = Math.abs(deltaY);
		}
		const id = elementId(`edge:${edge.from}:${edge.to}:${edge.label ?? ""}`);
		const labelId = edge.label ? elementId(`edge-label:${edge.from}:${edge.to}:${edge.label}`) : undefined;
		elements.push({
			...commonElement(id, "arrow", elementX, elementY, width, height),
			points,
			lastCommittedPoint: null,
			startBinding: { elementId: boxIds.get(edge.from), focus: 0, gap: 1 },
			endBinding: { elementId: boxIds.get(edge.to), focus: 0, gap: 1 },
			boundElements: labelId ? [{ type: "text", id: labelId }] : null,
			startArrowhead: null,
			endArrowhead: "arrow",
		});
		if (edge.label && labelId) {
			const labelEndX = horizontal ? to.x : to.x + to.width / 2;
			const labelEndY = horizontal ? to.y + to.height / 2 : to.y;
			elements.push({
				...commonElement(labelId, "text", (startX + labelEndX) / 2, (startY + labelEndY) / 2 - 12, Math.max(40, edge.label.length * 9), 24),
				text: edge.label,
				fontSize: 16,
				fontFamily: 1,
				textAlign: "center",
				verticalAlign: "middle",
				containerId: id,
				originalText: edge.label,
				autoResize: true,
				lineHeight: 1.25,
				baseline: 18,
			});
		}
	}
	for (const node of orderedNodes) {
		const position = positions.get(node.id)!;
		const boxId = boxIds.get(node.id)!;
		const nodeTextId = textIds.get(node.id)!;
		const boundElements = [
			{ type: "text", id: nodeTextId },
			...[...(boundArrowIds.get(node.id) ?? [])].map((id) => ({ type: "arrow", id })),
		];
		elements.push({ ...commonElement(boxId, node.shape ?? "rectangle", position.x, position.y, position.width, position.height), boundElements });
		elements.push({
			...commonElement(nodeTextId, "text", position.x, position.y + 28, position.width, 24),
			text: node.label,
			fontSize: 16,
			fontFamily: 1,
			textAlign: "center",
			verticalAlign: "middle",
			containerId: boxId,
			originalText: node.label,
			autoResize: false,
			lineHeight: 1.25,
			baseline: 18,
		});
	}
	if (title) {
		elements.push({
			...commonElement(elementId(`title:${title}`), "text", 80, 24, Math.max(100, title.length * 10), 24),
			text: title,
			fontSize: 20,
			fontFamily: 1,
			textAlign: "left",
			verticalAlign: "middle",
			containerId: null,
			originalText: title,
			autoResize: true,
			lineHeight: 1.25,
			baseline: 22,
		});
	}

	return stableValue({
		type: "excalidraw",
		version: 2,
		source: "pi-setup visualize",
		elements,
		appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
		files: {},
	});
}

export function serializeExcalidraw(value: unknown): string {
	const serialized = `${JSON.stringify(stableValue(value), null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} UTF-8 bytes.`);
	return serialized;
}

function graphWireframe(nodesValue: unknown, edgesValue: unknown): string {
	const { nodes, edges } = validateGraph(nodesValue, edgesValue);
	const labels = new Map(nodes.map((node) => [node.id, node.label]));
	const lines = ["Structured graph"];
	for (const edge of edges) lines.push(`[${edge.from}: ${labels.get(edge.from)}] ──${edge.label ? ` ${edge.label} ` : ""}▶ [${edge.to}: ${labels.get(edge.to)}]`);
	const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
	for (const node of nodes) if (!connected.has(node.id)) lines.push(`[${node.id}: ${node.label}]`);
	return outputText(bounded(lines.join("\n"), MAX_WIREFRAME_CHARS), "wireframe", MAX_WIREFRAME_BYTES);
}

interface SafeArtifactTarget {
	display: string;
	absolute: string;
	parent: Awaited<ReturnType<typeof open>>;
	filename: string;
}

const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const noFollowWriteFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

function descriptorPath(directory: Awaited<ReturnType<typeof open>>, name: string): string {
	return `/proc/self/fd/${directory.fd}/${name}`;
}

async function openValidatedDirectory(parent: Awaited<ReturnType<typeof open>>, segment: string): Promise<Awaited<ReturnType<typeof open>>> {
	const path = descriptorPath(parent, segment);
	try {
		return await open(path, directoryFlags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			await mkdir(path);
		} catch (mkdirError) {
			if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
		}
		return open(path, directoryFlags);
	}
}

async function safeArtifactPath(cwd: string, value: unknown): Promise<SafeArtifactTarget> {
	const display = text(value, "path", MAX_ARTIFACT_PATH_CHARS);
	if (isAbsolute(display) || win32.isAbsolute(display) || !SAFE_PATH.test(display) || display.startsWith("/") || display.includes("//")) {
		throw new Error("path must be a simple project-relative path using letters, numbers, ., _, -, and /.");
	}
	const segments = display.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("path cannot contain empty, . or .. segments.");
	if (!display.toLowerCase().endsWith(".excalidraw")) throw new Error("artifact path must end in .excalidraw.");

	const root = await realpath(cwd);
	let parent = await open(root, directoryFlags);
	try {
		for (const segment of segments.slice(0, -1)) {
			const next = await openValidatedDirectory(parent, segment);
			await parent.close();
			parent = next;
		}
		const filename = segments.at(-1)!;
		const absolute = join(root, ...segments);
		try {
			const existing = await open(descriptorPath(parent, filename), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			try {
				if (!(await existing.stat()).isFile()) throw new Error("artifact path must name a regular file, not a symlink or directory.");
			} finally {
				await existing.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return { absolute, display, parent, filename };
	} catch (error) {
		await parent.close().catch(() => undefined);
		throw error;
	}
}

async function writeArtifactAtomically(target: SafeArtifactTarget, serialized: string): Promise<void> {
	const temporaryName = `.${target.filename}.${randomUUID()}.tmp`;
	const temporaryPath = descriptorPath(target.parent, temporaryName);
	let temporary;
	try {
		temporary = await open(temporaryPath, noFollowWriteFlags, 0o600);
		await temporary.writeFile(serialized, "utf8");
		await temporary.sync();
		await temporary.close();
		temporary = undefined;
		// rename replaces the destination entry itself; it never follows a final
		// symlink. The parent remains pinned by the validated directory handle.
		await rename(temporaryPath, descriptorPath(target.parent, target.filename));
	} finally {
		if (temporary) await temporary.close().catch(() => undefined);
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function validateVisualizationRequest(value: unknown): { action: VisualizationAction; format: VisualizationFormat; target?: string; title?: string; direction?: "LR" | "TD"; source?: unknown; nodes?: unknown; edges?: unknown; path?: unknown } {
	if (!value || typeof value !== "object") throw new Error("visualization input must be an object.");
	const params = value as Record<string, unknown>;
	const action = params.action;
	const format = params.format;
	const target = params.target;
	if (action !== "preview" && action !== "viewer" && action !== "terminal_viewer" && action !== "artifact") throw new Error("action must be preview, viewer, terminal_viewer, or artifact.");
	if (format !== "mermaid" && format !== "excalidraw") throw new Error("format must be mermaid or excalidraw.");
	if (target !== undefined && target !== "plan_board" && target !== "terminal_viewer" && target !== "open" && target !== "update" && target !== "status" && target !== "close") throw new Error("target must be plan_board, terminal_viewer, open, update, or close.");
	if (action === "preview") {
		if (target !== undefined && !(target === "plan_board" && format === "excalidraw")) throw new Error("preview only accepts target plan_board for Excalidraw scenes.");
		if (format === "mermaid" && typeof params.source !== "string") throw new Error("Mermaid preview requires source.");
		if (format === "excalidraw" && !Array.isArray(params.nodes)) throw new Error("Excalidraw graphs require nodes.");
	}
	if (action === "viewer") {
		if (target !== undefined && target !== "terminal_viewer") throw new Error("viewer only accepts target terminal_viewer for compatibility.");
		if (format !== "excalidraw") throw new Error("Only Excalidraw graphs can open a viewer.");
		if (!Array.isArray(params.nodes)) throw new Error("Excalidraw graphs require nodes.");
	}
	if (action === "artifact") {
		if (target !== undefined) throw new Error("artifact does not accept target.");
		if (format !== "excalidraw") throw new Error("Only Excalidraw graphs can be written as artifacts.");
		if (!Array.isArray(params.nodes)) throw new Error("Excalidraw graphs require nodes.");
		if (typeof params.path !== "string") throw new Error("Excalidraw artifacts require path.");
	}
	if (action === "terminal_viewer") {
		if (target !== "open" && target !== "update" && target !== "status" && target !== "close") throw new Error("terminal_viewer requires target open, update, status, or close.");
		if (format !== "excalidraw") throw new Error("Only Excalidraw graphs can open a viewer.");
		const needsGraph = target === "open" || target === "update";
		if (needsGraph && !Array.isArray(params.nodes)) throw new Error(`${target} requires nodes.`);
		if (!needsGraph && (params.nodes !== undefined || params.edges !== undefined || params.direction !== undefined)) throw new Error(`${target} does not accept graph fields.`);
	}
	const title = params.title === undefined ? undefined : text(params.title, "title", 120, false);
	const direction = params.direction === undefined ? undefined : params.direction;
	if (direction !== undefined && direction !== "LR" && direction !== "TD") throw new Error("direction must be LR or TD.");
	return { action, format, target: typeof target === "string" ? target : undefined, title, direction, source: params.source, nodes: params.nodes, edges: params.edges, path: params.path };
}

function mermaidResult(source: string, graph: ParsedMermaidGraph, title?: string) {
	const heading = title ? `## ${title}\n\n` : "";
	return outputText(`${heading}Mermaid preview:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nTerminal wireframe fallback:\n\n\`\`\`text\n${mermaidWireframe(graph)}\n\`\`\``, "visualization output", MAX_OUTPUT_BYTES);
}

function styledMermaidPreview(source: string, theme: { fg: (color: string, value: string) => string; bold: (value: string) => string }): string | undefined {
	const art = renderMermaid(source);
	if (!art || art.width > 96) return undefined;
	return art.styled.map((row) => row.map((span) => {
		switch (span.cls) {
			case "border": return theme.fg("borderMuted", span.text);
			case "text": return theme.fg("text", span.text);
			case "edge": return theme.fg("accent", span.text);
			case "edgeLabel": return theme.fg("muted", span.text);
			case "title": return theme.fg("accent", theme.bold(span.text));
			default: return span.text;
		}
	}).join("")).join("\n");
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.find((part) => part.type === "text")?.text ?? "Visualization completed.";
}

function terminalPaneId(session: TerminalViewerSession | undefined): string | undefined {
	if (!session) return undefined;
	for (const key of ["paneId", "pane_id", "id"]) {
		const value = session.binding?.[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return session.binding ? "visualization-viewer" : "local-terminal-viewer";
}

function terminalAcknowledgement(operation: string, status: string, paneId: string | undefined, revision: number): string {
	return `Terminal viewer ${operation}: ${status}${paneId ? ` (pane ${paneId}, revision ${revision})` : ` (revision ${revision})`}.`;
}

interface TerminalViewerSession {
	endpoint: TerminalViewerEndpoint;
	socket: string;
	child?: import("node:child_process").ChildProcess;
	binding?: Record<string, unknown>;
	revision: number;
}

export default function visualization(pi: ExtensionAPI): void {
	let approvalMode = "auto";
	let viewer: ViewerSession | undefined;
	let terminalViewer: TerminalViewerSession | undefined;
	let closingViewer: Promise<void> | undefined;
	let closingTerminalViewer: Promise<void> | undefined;
	const events = (pi as ExtensionAPI & { events?: { on?: (event: string, handler: (value?: unknown) => void) => void } }).events;
	events?.on?.("approval-mode:changed", (value) => {
		if (value && typeof value === "object" && "mode" in value && typeof value.mode === "string") {
			approvalMode = value.mode;
			viewer?.setWritable(approvalMode !== "plan" && approvalMode !== "review");
		}
	});
	const closeViewer = async (): Promise<void> => {
		if (closingViewer) return closingViewer;
		const active = viewer;
		viewer = undefined;
		if (!active) return;
		const closing = (async () => {
			try {
				await active.close();
			} finally {
				closingViewer = undefined;
			}
		})();
		closingViewer = closing;
		return closing;
	};
	const closeTerminal = async (cwd = process.cwd()): Promise<void> => {
		if (closingTerminalViewer) return closingTerminalViewer;
		const active = terminalViewer;
		terminalViewer = undefined;
		const herdr = process.env.HERDR_ENV === "1" && typeof (events as { emit?: unknown } | undefined)?.emit === "function";
		if (!active && !herdr) return;
		const closing = (async () => {
			try {
				if (!active) {
					await new Promise<void>((resolve, reject) => {
						(events as { emit: (name: string, value: unknown) => void }).emit("herdr:close-terminal-viewer", {
							role: "visualization-viewer", cwd, socket: "",
							respond: (result: { ok: boolean; error?: string }) => result.ok ? resolve() : reject(new Error(result.error || "Herdr could not close the terminal viewer.")),
						});
					});
					return;
				}
				if (herdr) {
					await new Promise<void>((resolve, reject) => {
						(events as { emit: (name: string, value: unknown) => void }).emit("herdr:close-terminal-viewer", {
							role: "visualization-viewer", cwd: active.binding?.cwd ?? process.cwd(), socket: active.socket,
							respond: (result: { ok: boolean; error?: string }) => result.ok ? resolve() : reject(new Error(result.error || "Herdr could not close the terminal viewer.")),
						});
					});
				} else {
					await sendTerminalViewerCommand(active.endpoint.socket, { op: "close" }).catch(() => undefined);
					active.child?.kill();
				}
			} finally {
				if (active) await active.endpoint.cleanup();
				closingTerminalViewer = undefined;
			}
		})();
		closingTerminalViewer = closing;
		return closing;
	};
	const startTerminal = async (scene: Record<string, unknown>, cwd: string): Promise<TerminalViewerSession> => {
		const endpoint = await createTerminalViewerEndpoint();
		try {
			const herdr = process.env.HERDR_ENV === "1" && typeof (events as { emit?: unknown } | undefined)?.emit === "function";
			if (herdr) {
				const opened = await new Promise<{ binding: Record<string, unknown>; revision?: number }>((resolve, reject) => {
					(events as { emit: (name: string, value: unknown) => void }).emit("herdr:open-terminal-viewer", {
						role: "visualization-viewer", cwd, socket: endpoint.socket, scene,
						respond: (result: { ok: boolean; error?: string; binding?: Record<string, unknown>; revision?: number }) => result.ok && result.binding ? resolve({ binding: result.binding, revision: result.revision }) : reject(new Error(result.error || "Herdr could not open the terminal viewer.")),
					});
				});
				return { endpoint, socket: typeof opened.binding.socket === "string" ? opened.binding.socket : endpoint.socket, binding: opened.binding, revision: opened.revision ?? 1 };
			}
			const child = await spawnLocalTerminalViewer(endpoint);
			await sendTerminalViewerCommand(endpoint.socket, { op: "set_scene", revision: 1, scene });
			return { endpoint, socket: endpoint.socket, child, revision: 1 };
		} catch (error) {
			await endpoint.cleanup();
			throw error;
		}
	};
	const reconcileTerminalOnSessionStart = async (cwd: string): Promise<void> => {
		const active = terminalViewer;
		if (!active) return;
		const herdr = process.env.HERDR_ENV === "1" && typeof (events as { emit?: unknown } | undefined)?.emit === "function";
		// A local child owns the terminal state and cannot survive a reload safely.
		// Herdr-managed panes are different: ask Herdr for their live binding and
		// retain a healthy viewer instead of opening a second pane.
		if (!herdr) { await closeTerminal(cwd); return; }
		if (!active.binding) {
			// HERDR_ENV may be inherited by a local fallback. Do not send a
			// Herdr close request for a session that Herdr does not own.
			terminalViewer = undefined;
			await sendTerminalViewerCommand(active.endpoint.socket, { op: "close" }).catch(() => undefined);
			active.child?.kill();
			await active.endpoint.cleanup().catch(() => undefined);
			return;
		}
		try {
			const remote = await new Promise<{ status?: string; binding?: Record<string, unknown>; revision?: number }>((resolve, reject) => {
				(events as { emit: (name: string, value: unknown) => void }).emit("herdr:status-terminal-viewer", {
					role: "visualization-viewer", cwd,
					respond: (result: { ok: boolean; error?: string; status?: string; binding?: Record<string, unknown>; revision?: number }) => result.ok ? resolve(result) : reject(new Error(result.error || "Herdr could not reconcile the terminal viewer.")),
				});
			});
			if (remote.status === "ready") {
				if (remote.binding) active.binding = remote.binding;
				if (typeof remote.binding?.socket === "string") active.socket = remote.binding.socket;
				if (typeof remote.revision === "number") active.revision = remote.revision;
				return;
			}
			terminalViewer = undefined;
			await active.endpoint.cleanup();
		} catch {
			// Do not leave a dead child/socket or stale in-memory session attached to
			// the next tool call. Herdr itself owns any verified surviving pane.
			terminalViewer = undefined;
			await active.endpoint.cleanup().catch(() => undefined);
		}
	};
	const lifecycle = pi as ExtensionAPI & { on?: (event: string, handler: (...args: any[]) => any) => void };
	lifecycle.on?.("session_start", (_event: unknown, context?: { cwd?: string }) => { void closeViewer(); void reconcileTerminalOnSessionStart(context?.cwd ?? process.cwd()); });
	lifecycle.on?.("session_shutdown", () => { void closeViewer(); void closeTerminal(); });
	pi.registerTool({
		name: "visualize",
		label: "Visualize",
		description: "Preview a bounded Mermaid or Excalidraw graph, open the browser viewer, open/update/close a terminal-native Excalidraw viewer, or write an artifact. Terminal viewer control is disabled in Plan and Review; browser writes are read-only there and artifacts require normal execution.",
		promptSnippet: "Preview a graph, open the local Excalidraw viewer, or write an explicit artifact",
		promptGuidelines: [
			"Use action preview while planning; it never starts a server or writes files. For an explicit active Plan Board scene update, use preview with target plan_board; this never opens a second diagram pane.",
			"Use action viewer for the existing editable browser view; use target terminal_viewer (or action terminal_viewer) for the interactive ANSI viewer in a dedicated Herdr pane.",
			"Use terminal_viewer target update to replace the current independent diagram and target close to close its managed viewer; never use herdr_shell, a Notes pane, or the Plan Board pane for independent diagrams.",
			"Use Mermaid for a quick terminal preview with graph TD or graph LR and simple IDs.",
			"Use action artifact only after approval, with a project-relative .excalidraw path and structured nodes and edges.",
			"Keep graphs small and labels plain; never put HTML, JavaScript, shell commands, or secrets in a visualization.",
		],
		parameters: visualizeParameters,
		executionMode: "sequential",
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", `visualize · ${args.action} · ${args.format}`), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) return new Text(theme.fg("error", resultText(result)), 1, 0);
			if (context.args.format === "mermaid" && typeof context.args.source === "string") {
				try {
					const preview = styledMermaidPreview(context.args.source, theme);
					if (preview) return new Text(preview, 1, 0);
				} catch {
					// The tool result remains the authoritative textual fallback.
				}
			}
			if (context.args.format === "excalidraw" && classifyVisualizationRequest(context.args) !== "terminal-viewer") {
				try {
					return new Text(graphWireframe(context.args.nodes, context.args.edges), 1, 0);
				} catch {
					// Fall through to the bounded tool result when rendering fails.
				}
			}
			return new Text(theme.fg("toolOutput", resultText(result)), 1, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestClass = classifyVisualizationRequest(params);
			const request = validateVisualizationRequest(params);
			const { action, format, title } = request;
			const terminalAction = requestClass === "terminal-viewer" || action === "terminal_viewer" || request.target === "terminal_viewer" || request.target === "open" || request.target === "update" || request.target === "status" || request.target === "close";
			if (approvalMode === "plan" && !isPreviewVisualizationRequest(params)) {
				throw new Error("Plan mode allows only visualize preview; viewer startup, terminal viewer control, and artifact writes require approval.");
			}
			if (approvalMode === "review" && (terminalAction || action === "artifact")) throw new Error("Review mode does not allow terminal viewer control or artifact writes.");
			if (terminalAction && request.target === "close") {
				const active = terminalViewer;
				const paneId = terminalPaneId(active);
				const revision = active?.revision ?? 0;
				await closeTerminal(ctx.cwd);
				return { content: [{ type: "text", text: terminalAcknowledgement("close", "closed", paneId, revision) }], details: { action, target: "close", status: "closed", paneId, revision } };
			}
			if (terminalAction && request.target === "status") {
				const active = terminalViewer;
				const herdr = process.env.HERDR_ENV === "1" && typeof (events as { emit?: unknown } | undefined)?.emit === "function";
				if (!active && herdr) {
					const remote = await new Promise<{ status?: string; binding?: Record<string, unknown>; revision?: number }>((resolve, reject) => {
						(events as { emit: (name: string, value: unknown) => void }).emit("herdr:status-terminal-viewer", {
							role: "visualization-viewer", cwd: ctx.cwd,
							respond: (result: { ok: boolean; error?: string; status?: string; binding?: Record<string, unknown>; revision?: number }) => result.ok ? resolve(result) : reject(new Error(result.error || "Herdr could not read terminal viewer status.")),
						});
					});
					const paneId = typeof remote.binding?.paneId === "string" ? remote.binding.paneId : typeof remote.binding?.pane_id === "string" ? remote.binding.pane_id : undefined;
					const revision = remote.revision ?? 0;
					const status = remote.status === "ready" ? "ready" : "closed";
					return { content: [{ type: "text", text: terminalAcknowledgement("status", status, paneId, revision) }], details: { action, target: "status", status, paneId, revision, ...(status === "ready" ? { role: "visualization-viewer" } : {}) } };
				}
				if (!active) return { content: [{ type: "text", text: terminalAcknowledgement("status", "closed", undefined, 0) }], details: { action, target: "status", status: "closed", revision: 0 } };
				try {
					const response = await sendTerminalViewerCommand(active.socket, { op: "ping" });
					active.revision = response.revision ?? active.revision;
					const paneId = terminalPaneId(active);
					return { content: [{ type: "text", text: terminalAcknowledgement("status", "ready", paneId, active.revision) }], details: { action, target: "status", status: "ready", paneId, revision: active.revision, role: "visualization-viewer" } };
				} catch {
					const paneId = terminalPaneId(active);
					await closeTerminal();
					return { content: [{ type: "text", text: terminalAcknowledgement("status", "closed", paneId, active.revision) }], details: { action, target: "status", status: "closed", paneId, revision: active.revision } };
				}
			}
			if (action === "preview" && format === "mermaid") {
				const graph = parseMermaid(request.source);
				return { content: [{ type: "text", text: mermaidResult(graph.source, graph, title) }], details: { action, format, nodeCount: graph.nodes.size, edgeCount: graph.edges.length } };
			}

			const graph = buildExcalidrawGraph(request.nodes, request.edges, title, request.direction);
			const serialized = serializeExcalidraw(graph);
			const parsed = graph as { elements: unknown[] };
			if (action === "preview") {
				if (request.target === "plan_board" && typeof (events as { emit?: unknown } | undefined)?.emit === "function") {
					(events as { emit: (name: string, value: unknown) => void }).emit("plan-board:scene", { cwd: ctx.cwd, scene: graph });
				}
				const preview = outputText(`Excalidraw graph preview (not written):\n\n\`\`\`text\n${graphWireframe(request.nodes, request.edges)}\n\`\`\``, "visualization output", MAX_OUTPUT_BYTES);
				return {
					content: [{ type: "text", text: preview }],
					details: { action, format, nodeCount: request.nodes?.length ?? 0, edgeCount: request.edges?.length ?? 0, elementCount: parsed.elements.length },
				};
			}

			if (terminalAction) {
				try {
					const target = request.target ?? "update";
					if (!terminalViewer) {
						terminalViewer = await startTerminal(graph, ctx.cwd);
					} else {
						try {
							const accepted = await sendTerminalViewerCommand(terminalViewer.socket, { op: "update", revision: terminalViewer.revision, scene: graph });
							terminalViewer.revision = accepted.revision ?? terminalViewer.revision + 1;
						} catch {
							// A q exit, Herdr restart, stale socket, or owner loss must not
							// turn a valid update into a second pane. Retire only the known
							// binding and reopen through the dedicated-role path.
							await closeTerminal(ctx.cwd).catch(() => undefined);
							terminalViewer = await startTerminal(graph, ctx.cwd);
						}
					}
					const operation = target === "open" || terminalViewer.revision === 1 ? "open" : "update";
					const paneId = terminalPaneId(terminalViewer);
					const terminalResult = terminalAcknowledgement(operation, "ready", paneId, terminalViewer.revision);
					return { content: [{ type: "text", text: terminalResult }], details: { action, target: request.target ?? "update", status: "ready", paneId, role: "visualization-viewer", revision: terminalViewer.revision } };
				} catch (error) {
					await closeTerminal();
					throw error;
				}
			}

			if (action === "viewer") {
				try {
					if (viewer) await closeViewer();
					viewer = await startExcalidrawViewer(graph, { writable: approvalMode !== "plan" && approvalMode !== "review" });
					// Keep the transition call for mode changes and future startup paths.
					viewer.setWritable(approvalMode !== "plan" && approvalMode !== "review");
					const viewerResult = outputText(`Local Excalidraw viewer ready: ${viewer.url}\n\nOpen this URL in a browser outside Herdr. The server listens on loopback only; terminal wireframe fallback:\n\n\`\`\`text\n${graphWireframe(request.nodes, request.edges)}\n\`\`\``, "visualization output", MAX_OUTPUT_BYTES);
					return { content: [{ type: "text", text: viewerResult }], details: { action, format, status: "ready", url: viewer.url, host: "127.0.0.1", port: viewer.port, revision: viewer.getScene().revision, nodeCount: request.nodes?.length ?? 0, edgeCount: request.edges?.length ?? 0, elementCount: parsed.elements.length } };
				} catch (error) {
					await closeViewer();
					const fallback = outputText(`Local Excalidraw viewer unavailable (${error instanceof Error ? error.message : "startup failed"}). Terminal wireframe fallback:\n\n\`\`\`text\n${graphWireframe(request.nodes, request.edges)}\n\`\`\``, "visualization output", MAX_OUTPUT_BYTES);
					return { content: [{ type: "text", text: fallback }], details: { action, format, status: "fallback", reason: error instanceof Error ? error.message : "startup failed", nodeCount: request.nodes?.length ?? 0, edgeCount: request.edges?.length ?? 0, elementCount: parsed.elements.length } };
				}
			}

			const target = await safeArtifactPath(ctx.cwd, request.path);
			try {
				await writeArtifactAtomically(target, serialized);
			} finally {
				await target.parent.close();
			}
			const artifactResult = outputText(`Wrote Excalidraw artifact: ${target.display}\n\nTerminal wireframe fallback:\n\n\`\`\`text\n${graphWireframe(request.nodes, request.edges)}\n\`\`\``, "visualization output", MAX_OUTPUT_BYTES);
			return {
				content: [{ type: "text", text: artifactResult }],
				details: { action, format, path: target.display, nodeCount: request.nodes?.length ?? 0, edgeCount: request.edges?.length ?? 0, elementCount: parsed.elements.length },
			};
		},
	});
}
