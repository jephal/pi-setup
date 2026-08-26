#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_CODE_BYTES = 2 * 1024 * 1024;
const MAX_NOTES = 5_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_UNDO_STEPS = 100;
const CONTROL_SEQUENCE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[()][0-2A-Za-z])/g;
const SELECTED_STYLE = "\x1b[7m";
const RESET_STYLE = "\x1b[0m";
const IGNORED_CODE_DIRECTORIES = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "coverage", "target"]);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	console.log("Usage: notes-tui --notes PATH [--code-root PATH] [--note NOTE_PATH] [--read-only]");
	process.exit(0);
}
if (!args.notes) fail("--notes PATH is required.");
if (!process.stdin.isTTY || !process.stdout.isTTY) fail("notes-tui requires an interactive terminal.");

const root = await getNotesRoot(args.notes);
const codeRoot = args.codeRoot ? await getNotesRoot(args.codeRoot) : undefined;
let explorer = await listExplorer(root, "notes");
let codeExplorer = codeRoot ? await listExplorer(codeRoot, "code") : [];
let explorerRoots = makeExplorerRoots(explorer, codeExplorer);
let notes = flattenFiles(explorer);
let allFiles = [...notes, ...flattenFiles(codeExplorer)];
let visibleNotes = allFiles;
let searchActive = false;
let selected = 0;
let view = "list";
let inputMode = false;
let inputQuery = "";
let notePath;
let activeKind = "notes";
let noteContent = "";
let gitSummary;
let editorLines = [];
let editorRow = 0;
let editorColumn = 0;
let editorMode = "normal";
let editorDirty = false;
let editorUndo = [];
let editorOriginalStat;
let scroll = 0;
let status = "j/k or arrows: navigate · Enter: open/toggle · /: search · g: git status · q: quit";
let terminalReady = false;

gitSummary = readGitSummary(root);

function parseArgs(values) {
	const parsed = {};
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value === "--help" || value === "-h") parsed.help = true;
		else if (value === "--read-only") parsed.readOnly = true;
		else if (value === "--notes" || value === "-v") parsed.notes = values[++index];
		else if (value === "--code-root" || value === "-c") parsed.codeRoot = values[++index];
		else if (value === "--note" || value === "-n") parsed.note = values[++index];
		else fail(`Unknown option: ${value}`);
	}
	return parsed;
}

function fail(message) {
	console.error(`notes-tui: ${message}`);
	process.exit(1);
}

function sanitizeTerminal(value) {
	return String(value)
		.replace(CONTROL_SEQUENCE, "")
		.replace(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f]/g, "");
}

function sanitizeDisplay(value) {
	return sanitizeTerminal(value).replace(/[\r\n\t]/g, " ");
}

function assertInside(rootPath, candidate) {
	const pathFromRoot = relative(rootPath, candidate);
	if (pathFromRoot !== "" && (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot))) {
		throw new Error("Path must stay inside the configured notes directory.");
	}
}

async function getNotesRoot(notesPath) {
	const rootPath = await fs.realpath(resolve(notesPath)).catch(() => {
		throw new Error(`Notes directory is unavailable: ${notesPath}`);
	});
	const rootStat = await fs.stat(rootPath);
	if (!rootStat.isDirectory()) throw new Error(`Notes path is not a directory: ${rootPath}`);
	return rootPath;
}

async function listExplorer(rootPath, kind) {
	const visited = { count: 0 };
	async function visit(directory, parentPath = "") {
		const folders = [];
		const files = [];
		const entries = await fs.readdir(directory, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (visited.count >= MAX_NOTES || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			const child = join(directory, entry.name);
			const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (kind === "code" && IGNORED_CODE_DIRECTORIES.has(entry.name)) continue;
				folders.push({ type: "folder", kind, name: entry.name, path: childPath, children: await visit(child, childPath), expanded: false });
			} else if (entry.isFile() && await isVisibleFile(child, entry.name, kind)) {
				const realPath = await fs.realpath(child);
				assertInside(rootPath, realPath);
				files.push({ type: "file", kind, name: entry.name, path: childPath, absolute: realPath });
				visited.count++;
			}
		}
		return [...folders, ...files];
	}
	return visit(rootPath);
}

async function isVisibleFile(filePath, name, kind) {
	if (kind === "notes") return name.toLocaleLowerCase().endsWith(".md");
	try {
		const fileStat = await fs.stat(filePath);
		if (fileStat.size > MAX_CODE_BYTES) return false;
		return !(await fs.readFile(filePath, "utf8")).includes("\0");
	} catch {
		return false;
	}
}

function flattenFiles(items) {
	return items.flatMap((item) => item.type === "folder" || item.type === "section" ? flattenFiles(item.children) : [item]);
}

function makeExplorerRoots(noteItems, codeItems) {
	return [
		{ type: "section", kind: "notes", name: "Notes", path: "__notes__", children: noteItems, expanded: true },
		...(codeRoot ? [{ type: "section", kind: "code", name: "Code (read-only)", path: "__code__", children: codeItems, expanded: false }] : []),
	];
}

function explorerRows(items, parentPath = "", depth = 0, rows = []) {
	for (const item of items) {
		rows.push({ item, parentPath, depth });
		if ((item.type === "folder" || item.type === "section") && item.expanded) explorerRows(item.children, item.path, depth + 1, rows);
	}
	return rows;
}

function readGitSummary(rootPath) {
	try {
		const output = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "status", "--short", "--branch"], {
			cwd: rootPath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const lines = output.trimEnd().split(/\r?\n/).filter(Boolean);
		if (lines.length === 0) return "git unavailable";
		return lines.length === 1 ? `${lines[0]} · clean` : `${lines[0]} · ${lines.length - 1} change(s)`;
	} catch {
		return "git unavailable";
	}
}

async function readFileEntry(file) {
	const linkStat = await fs.lstat(file.absolute);
	if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new Error(`File is not a regular file: ${file.path}`);
	const limit = file.kind === "code" ? MAX_CODE_BYTES : MAX_NOTE_BYTES;
	if (linkStat.size > limit) throw new Error(`File is larger than ${limit} bytes: ${file.path}`);
	return fs.readFile(file.absolute, "utf8");
}

function wrapLine(line, width) {
	const safeWidth = Math.max(10, width);
	if (!line) return [""];
	const result = [];
	for (let index = 0; index < line.length; index += safeWidth) result.push(line.slice(index, index + safeWidth));
	return result;
}

function renderMarkdown(content, width) {
	const output = [];
	let inCode = false;
	for (const sourceLine of sanitizeTerminal(content).replaceAll("\r\n", "\n").split("\n")) {
		if (/^\s*```/.test(sourceLine)) {
			inCode = !inCode;
			output.push("  " + (inCode ? "[code]" : "[/code]"));
			continue;
		}
		if (inCode) {
			output.push(...wrapLine("  " + sourceLine, width));
			continue;
		}
		const heading = /^(\s*)(#{1,6})\s+(.*)$/.exec(sourceLine);
		if (heading) output.push(...wrapLine(`${heading[1]}${heading[2]} ${inlineMarkdown(heading[3])}`, width));
		else {
			const list = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(sourceLine);
			output.push(...wrapLine(list ? `${list[1]}${list[2]}${inlineMarkdown(list[3])}` : inlineMarkdown(sourceLine), width));
		}
	}
	return output;
}

function inlineMarkdown(value) {
	return value
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, label) => label || target)
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/__(.*?)__/g, "$1")
		.replace(/\*(.*?)\*/g, "$1")
		.replace(/_(.*?)_/g, "$1")
		.replace(/~~(.*?)~~/g, "$1");
}

async function searchNotes(query) {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return allFiles;
	const matches = [];
	for (const note of allFiles) {
		if (matches.length >= MAX_SEARCH_RESULTS) break;
		if (note.path.toLocaleLowerCase().includes(needle)) {
			matches.push(note);
			continue;
		}
		try {
			if ((await readFileEntry(note)).toLocaleLowerCase().includes(needle)) matches.push(note);
		} catch {
			// A note can disappear while the directory is being edited; skip it.
		}
	}
	return matches;
}

function currentItems() {
	return searchActive ? visibleNotes : explorerRows(explorerRoots);
}

function selectedLine(text, isSelected) {
	return isSelected ? `${SELECTED_STYLE}${text}${RESET_STYLE}` : text;
}

function explorerLine(row, index) {
	const item = row.item;
	const prefix = "  ".repeat(row.depth);
	const isContainer = item.type === "folder" || item.type === "section";
	const marker = isContainer ? (item.expanded ? "▾" : "▸") : " ";
	const suffix = isContainer ? "/" : "";
	return selectedLine(`${index === selected ? ">" : " "} ${prefix}${marker} ${sanitizeDisplay(item.name)}${suffix}`, index === selected);
}

function searchLine(note, index) {
	const kind = note.kind === "code" ? "[code] " : "";
	return selectedLine(`${index === selected ? ">" : " "} ${kind}${sanitizeDisplay(note.path)}`, index === selected);
}

function renderCode(content, width) {
	return sanitizeTerminal(content).replaceAll("\r\n", "\n").split("\n").flatMap((line, index) =>
		wrapLine(`${String(index + 1).padStart(5, " ")} │ ${line}`, width),
	);
}

function bodyHeight() {
	return Math.max(3, (process.stdout.rows || 24) - 3);
}

function draw() {
	const width = Math.max(20, process.stdout.columns || 80);
	const height = bodyHeight();
	const title = view === "note" ? `${activeKind === "code" ? "CODE" : "NOTE"}  ${notePath}` : `NOTES  ${relative(process.cwd(), root) || "."}`;
	const header = `\x1b[1;36m${sanitizeDisplay(`${title} · ${gitSummary}`).slice(0, width)}\x1b[0m`;
	let body;
	if (inputMode) {
		body = visibleNotes.map((note, index) => searchLine(note, index));
		body.unshift(`Search: ${sanitizeDisplay(inputQuery)}_`);
	} else if (view === "note") {
		body = activeKind === "code" ? renderCode(noteContent, width) : renderMarkdown(noteContent, width);
	} else if (view === "edit") {
		const availableWidth = Math.max(10, width - 8);
		body = editorLines.map((line, index) => {
			const safeLine = sanitizeTerminal(line);
			let content = safeLine;
			if (index === editorRow) {
				const cursor = Math.min(editorColumn, safeLine.length);
				content = `${safeLine.slice(0, cursor)}▌${safeLine.slice(cursor)}`;
			}
			const rendered = `${String(index + 1).padStart(4, " ")} │ ${content}`.slice(0, width);
			return selectedLine(rendered, index === editorRow);
		});
	} else if (searchActive) {
		body = visibleNotes.map((note, index) => searchLine(note, index));
		if (body.length === 0) body = ["No matching notes found."];
	} else {
		body = currentItems().map((row, index) => explorerLine(row, index));
		if (body.length === 0) body = ["No Markdown notes found."];
	}
	const maxScroll = Math.max(0, body.length - height);
	if (view === "edit") {
		if (editorRow < scroll) scroll = editorRow;
		if (editorRow >= scroll + height) scroll = editorRow - height + 1;
	}
	scroll = Math.min(Math.max(0, scroll), maxScroll);
	const visible = body.slice(scroll, scroll + height);
	while (visible.length < height) visible.push("");
	const footer = sanitizeDisplay(inputMode ? "Enter: search · Esc: cancel · Ctrl-u: clear" : status).slice(0, width);
	process.stdout.write(`\x1b[2J\x1b[H${header}\n${visible.join("\n")}\n\x1b[2m${footer}\x1b[0m`);
}

function enterTerminal() {
	if (terminalReady) return;
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	terminalReady = true;
}

function leaveTerminal() {
	if (!terminalReady) return;
	process.stdin.setRawMode(false);
	process.stdin.pause();
	process.stdout.write("\x1b[?25h\x1b[?1049l");
	terminalReady = false;
}

function quit(code = 0) {
	leaveTerminal();
	process.exit(code);
}

async function openSelected() {
	const selectedItem = currentItems()[selected];
	const file = searchActive ? selectedItem : selectedItem?.item;
	if (!file || file.type !== "file") return;
	try {
		notePath = file.path;
		activeKind = file.kind;
		noteContent = await readFileEntry(file);
		view = "note";
		scroll = 0;
		status = file.kind === "code"
			? "Esc: explorer · j/k or arrows: scroll · read-only · q: quit"
			: "Esc: notes · j/k or arrows: scroll · e: edit · q: quit";
	} catch (error) {
		status = error instanceof Error ? error.message : String(error);
	}
}

async function enterEditor() {
	if (args.readOnly) {
		status = "Read-only mode is enabled.";
		return;
	}
	const note = notes.find((candidate) => candidate.path === notePath);
	if (!note || activeKind !== "notes") {
		status = "Code files are read-only.";
		return;
	}
	try {
		noteContent = await readFileEntry(note);
		editorLines = noteContent.split("\n");
		if (editorLines.length === 0) editorLines = [""];
		editorRow = 0;
		editorColumn = 0;
		editorMode = "normal";
		editorDirty = false;
		editorUndo = [];
		editorOriginalStat = await fs.stat(note.absolute);
		view = "edit";
		scroll = 0;
		status = "NORMAL · i/a/o: insert · x: delete · u: undo · Ctrl-S: save · Ctrl-Q: discard";
	} catch (error) {
		status = error instanceof Error ? error.message : String(error);
	}
}

function editorSnapshot() {
	return { lines: [...editorLines], row: editorRow, column: editorColumn };
}

function mutateEditor(mutator) {
	editorUndo.push(editorSnapshot());
	if (editorUndo.length > MAX_UNDO_STEPS) editorUndo.shift();
	mutator();
	editorDirty = true;
	clampEditorCursor();
}

function clampEditorCursor() {
	if (editorLines.length === 0) editorLines = [""];
	editorRow = Math.max(0, Math.min(editorRow, editorLines.length - 1));
	editorColumn = Math.max(0, Math.min(editorColumn, editorLines[editorRow].length));
}

function undoEditor() {
	const snapshot = editorUndo.pop();
	if (!snapshot) {
		status = "Nothing to undo.";
		return;
	}
	editorLines = snapshot.lines;
	editorRow = snapshot.row;
	editorColumn = snapshot.column;
	editorDirty = true;
}

async function saveEditor() {
	const note = notes.find((candidate) => candidate.path === notePath);
	if (!note || !editorDirty) return;
	const currentStat = await fs.stat(note.absolute);
	if (currentStat.mtimeMs !== editorOriginalStat.mtimeMs || currentStat.size !== editorOriginalStat.size) {
		status = "File changed outside the editor; reload before saving to avoid overwriting it.";
		return;
	}
	const temporaryPath = `${note.absolute}.pi-tmp-${process.pid}`;
	const content = editorLines.join("\n");
	try {
		await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
		await fs.rename(temporaryPath, note.absolute);
		editorOriginalStat = await fs.stat(note.absolute);
		noteContent = content;
		editorDirty = false;
		gitSummary = readGitSummary(root);
		status = `Saved ${note.path}.`;
	} catch (error) {
		await fs.unlink(temporaryPath).catch(() => {});
		status = error instanceof Error ? `Save failed: ${error.message}` : String(error);
	}
}

function leaveEditor(discard = false) {
	if (editorDirty && !discard) {
		status = "Unsaved changes; Ctrl-S saves or Ctrl-Q discards.";
		return;
	}
	view = "note";
	scroll = 0;
	status = "Esc: notes · e: edit · j/k or arrows: scroll · q: quit";
}

function moveEditor(rowDelta, columnDelta) {
	editorRow += rowDelta;
	editorColumn += columnDelta;
	clampEditorCursor();
}

async function handleEditorKey(key) {
	if (key === "\u0013") return saveEditor();
	if (key === "\u0011") return leaveEditor(true);
	if (key === "\u001a") return undoEditor();
	if (key === "escape" || key === "\u001b") {
		if (editorMode === "insert") {
			editorMode = "normal";
			status = "NORMAL · i/a/o: insert · x: delete · u: undo · Ctrl-S: save · Ctrl-Q: discard";
		} else leaveEditor();
		return;
	}

	if (editorMode === "insert") {
		if (key === "up") moveEditor(-1, 0);
		else if (key === "down") moveEditor(1, 0);
		else if (key === "left") moveEditor(0, -1);
		else if (key === "right") moveEditor(0, 1);
		else if (key === "home") editorColumn = 0;
		else if (key === "end") editorColumn = editorLines[editorRow].length;
		else if (key === "backspace" || key === "\u007f") {
			if (editorColumn > 0) mutateEditor(() => {
				editorLines[editorRow] = editorLines[editorRow].slice(0, editorColumn - 1) + editorLines[editorRow].slice(editorColumn);
				editorColumn--;
			});
			else if (editorRow > 0) mutateEditor(() => {
				const previousLength = editorLines[editorRow - 1].length;
				editorLines[editorRow - 1] += editorLines[editorRow];
				editorLines.splice(editorRow, 1);
				editorRow--;
				editorColumn = previousLength;
			});
		} else if (key === "delete") {
			if (editorColumn < editorLines[editorRow].length) mutateEditor(() => {
				editorLines[editorRow] = editorLines[editorRow].slice(0, editorColumn) + editorLines[editorRow].slice(editorColumn + 1);
			});
			else if (editorRow < editorLines.length - 1) mutateEditor(() => {
				editorLines[editorRow] += editorLines[editorRow + 1];
				editorLines.splice(editorRow + 1, 1);
			});
		} else if (key === "\r" || key === "\n") mutateEditor(() => {
			const rest = editorLines[editorRow].slice(editorColumn);
			editorLines[editorRow] = editorLines[editorRow].slice(0, editorColumn);
			editorLines.splice(editorRow + 1, 0, rest);
			editorRow++;
			editorColumn = 0;
		});
		else if (key.length === 1 && key >= " ") mutateEditor(() => {
			editorLines[editorRow] = editorLines[editorRow].slice(0, editorColumn) + key + editorLines[editorRow].slice(editorColumn);
			editorColumn++;
		});
		return;
	}

	if (key === "up" || key === "k") moveEditor(-1, 0);
	else if (key === "down" || key === "j") moveEditor(1, 0);
	else if (key === "left" || key === "h") moveEditor(0, -1);
	else if (key === "right" || key === "l") moveEditor(0, 1);
	else if (key === "home") editorColumn = 0;
	else if (key === "end") editorColumn = editorLines[editorRow].length;
	else if (key === "i") editorMode = "insert";
	else if (key === "a") {
		editorColumn = Math.min(editorColumn + 1, editorLines[editorRow].length);
		editorMode = "insert";
	} else if (key === "o") mutateEditor(() => {
		editorLines.splice(editorRow + 1, 0, "");
		editorRow++;
		editorColumn = 0;
		editorMode = "insert";
	});
	else if (key === "x" && editorColumn < editorLines[editorRow].length) mutateEditor(() => {
		editorLines[editorRow] = editorLines[editorRow].slice(0, editorColumn) + editorLines[editorRow].slice(editorColumn + 1);
	});
	else if (key === "u") undoEditor();
	else if (key === "q") leaveEditor();
	status = editorMode === "insert"
		? "INSERT · type · Enter: new line · Esc: normal · Ctrl-S: save · Ctrl-Q: discard"
		: "NORMAL · i/a/o: insert · x: delete · u: undo · Ctrl-S: save · Ctrl-Q: discard";
}

async function applySearch() {
	inputMode = false;
	const query = inputQuery.trim();
	visibleNotes = query ? await searchNotes(query) : notes;
	searchActive = Boolean(query);
	selected = 0;
	scroll = 0;
	view = "list";
	status = query ? `${visibleNotes.length} matching note(s) · Enter: open · /: search again` : "Showing all notes.";
	inputQuery = "";
}

function collapseOrMoveToParent() {
	const row = currentItems()[selected];
	if (!row) return;
	if ((row.item.type === "folder" || row.item.type === "section") && row.item.expanded) {
		row.item.expanded = false;
		return;
	}
	if (!row.parentPath) return;
	const parentIndex = currentItems().findIndex((candidate) => (candidate.item.type === "folder" || candidate.item.type === "section") && candidate.item.path === row.parentPath);
	if (parentIndex >= 0) selected = parentIndex;
}

function beginSearch() {
	inputMode = true;
	inputQuery = "";
	selected = 0;
	scroll = 0;
}

async function handleKey(key) {
	if (inputMode) {
		if (key === "\u0003") return quit(130);
		if (key === "\u001b" || key === "escape") {
			inputMode = false;
			inputQuery = "";
			return draw();
		}
		if (key === "\r" || key === "\n") {
			await applySearch();
			return draw();
		}
		if (key === "\u007f" || key === "backspace") inputQuery = inputQuery.slice(0, -1);
		else if (key === "\u0015") inputQuery = "";
		else if (key.length === 1 && key >= " ") inputQuery += key;
		return draw();
	}

	if (key === "\u0003") return quit(130);
	if (view === "edit") {
		await handleEditorKey(key);
		return draw();
	}
	if (key === "q") return quit(0);
	if (view === "note") {
		const page = bodyHeight();
		if (key === "escape" || key === "\u001b") {
			view = "list";
			scroll = 0;
			status = "j/k or arrows: navigate · Enter: open/toggle · /: search · g: git status · q: quit";
		} else if (key === "j" || key === "down") scroll++;
		else if (key === "k" || key === "up") scroll--;
		else if (key === "\u0004" || key === "pagedown") scroll += page;
		else if (key === "\u0015" || key === "pageup") scroll -= page;
		else if (key === "g") scroll = 0;
		else if (key === "G") scroll = Number.MAX_SAFE_INTEGER;
		else if (key === "/") beginSearch();
		else if (key === "e") await enterEditor();
		scroll = Math.max(0, scroll);
		return draw();
	}

	if (key === "j" || key === "down") selected++;
	else if (key === "k" || key === "up") selected--;
	else if (key === "pagedown" || key === "\u0004") selected += bodyHeight();
	else if (key === "pageup" || key === "\u0015") selected -= bodyHeight();
	else if (key === "\r" || key === "\n") {
		if (searchActive) await openSelected();
		else {
			const row = currentItems()[selected];
			if (row?.item.type === "folder" || row?.item.type === "section") row.item.expanded = !row.item.expanded;
			else await openSelected();
		}
	} else if (key === "l" || key === "right") {
		if (!searchActive) {
			const row = currentItems()[selected];
			if (row?.item.type === "folder" || row?.item.type === "section") row.item.expanded = true;
		}
	} else if (key === "h" || key === "left") {
		if (!searchActive) collapseOrMoveToParent();
	} else if (key === "/") beginSearch();
	else if (key === "g") {
		gitSummary = readGitSummary(root);
		status = gitSummary;
	} else if (key === "r") {
		explorer = await listExplorer(root, "notes");
		codeExplorer = codeRoot ? await listExplorer(codeRoot, "code") : [];
		explorerRoots = makeExplorerRoots(explorer, codeExplorer);
		notes = flattenFiles(explorer);
		allFiles = [...notes, ...flattenFiles(codeExplorer)];
		gitSummary = readGitSummary(root);
		visibleNotes = allFiles;
		searchActive = false;
		selected = 0;
		status = `Reloaded ${notes.length} note(s).`;
	}
	selected = Math.max(0, Math.min(selected, Math.max(0, currentItems().length - 1)));
	return draw();
}

function decodeInput(data) {
	if (data === "\x1b[A") return ["up"];
	if (data === "\x1b[B") return ["down"];
	if (data === "\x1b[C") return ["right"];
	if (data === "\x1b[D") return ["left"];
	if (data === "\x1b[H") return ["home"];
	if (data === "\x1b[F") return ["end"];
	if (data === "\x1b[3~") return ["delete"];
	if (data === "\x1b[5~") return ["pageup"];
	if (data === "\x1b[6~") return ["pagedown"];
	if (data === "\x1b") return ["escape"];
	if (data.startsWith("\x1b[")) return [];
	return [...data];
}

process.on("SIGWINCH", draw);
process.on("SIGINT", () => quit(130));
process.stdin.on("end", () => quit());
if (args.note) {
	const requested = String(args.note).replace(/^@/, "").replaceAll("\\", "/");
	const note = notes.find((candidate) => candidate.path === requested);
	if (!note) fail(`Note was not found in the notes directory: ${requested}`);
	notePath = note.path;
	activeKind = note.kind;
	noteContent = await readFileEntry(note);
	view = "note";
	status = "Esc: notes · j/k or arrows: scroll · e: edit · q: quit";
}
enterTerminal();
draw();
for await (const chunk of process.stdin) {
	for (const key of decodeInput(chunk.toString())) await handleKey(key);
}
