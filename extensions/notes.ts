import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotesVault, MAX_NOTE_BYTES, type NotesSearchMode, type NotesTransferAction, type NotesWriteMode } from "../src/notes/vault.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_LIST_LIMIT = 500;

const listNotesParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Folder inside the notes directory to list (default: root)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: "Maximum number of notes to return (default: 100)" })),
});

const searchParameters = Type.Object({
	query: Type.String({ description: "Literal text or regular expression to find" }),
	path: Type.Optional(Type.String({ description: "Folder inside the notes directory to search (default: root)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum number of matching notes (default: 20)" })),
	mode: Type.Optional(StringEnum(["literal", "regex", "filename"] as const, { description: "Search mode: literal (default), regex, or filename-only" })),
	glob: Type.Optional(Type.String({ description: "Optional glob relative to path, supporting * and **, such as *.md or **/*.md" })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching (default: false)" })),
	contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Additional lines before and after the first match (default: 0)" })),
	pathsOnly: Type.Optional(Type.Boolean({ description: "Return matching paths without snippets for minimal output" })),
});

const openViewerParameters = Type.Object({
	readOnly: Type.Optional(Type.Boolean({ description: "Open Neovim in read-only mode" })),
});

const openNoteParameters = Type.Object({
	path: Type.String({ description: "Markdown note path relative to the notes directory" }),
});

const gitParameters = Type.Object({
	action: StringEnum(["status", "diff", "commit"] as const, { description: "Explicit local Git operation for the notes repository" }),
	message: Type.Optional(Type.String({ description: "Commit message, required for commit" })),
});

const readNoteParameters = Type.Object({
	path: Type.String({ description: "Markdown note path relative to the notes directory" }),
});

const writeNoteParameters = Type.Object({
	path: Type.String({ description: "Markdown note path relative to the notes directory" }),
	content: Type.String({ description: "Complete note content, or content to append" }),
	mode: StringEnum(["create", "overwrite", "append"] as const, { description: "create, overwrite, or append to a Markdown note" }),
});

const transferNoteParameters = Type.Object({
	action: StringEnum(["copy", "move"] as const, { description: "Copy or move the note without sending its content through the model" }),
	source: Type.String({ description: "Existing Markdown note path relative to the notes directory" }),
	destination: Type.String({ description: "New Markdown note path relative to the notes directory" }),
});

function configuredNotes(): NotesVault {
	return NotesVault.fromEnvironment();
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

const nvimBinary = () => process.env.NOTES_NVIM_BIN ?? "nvim";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function nvimSocket(root: string): string {
	const runtimeDir = process.env.XDG_RUNTIME_DIR || "/tmp";
	const identity = createHash("sha256").update(root).digest("hex").slice(0, 16);
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	return `${runtimeDir}/pi-notes-${uid}-${identity}.sock`;
}

function viewerCommand(root: string, socket: string, readOnly: boolean): string {
	const initPath = fileURLToPath(new URL("../src/notes/nvim-init.lua", import.meta.url));
	const args = ["--clean", "-u", initPath, "--listen", socket, ...(readOnly ? ["-R"] : []), root];
	return [shellQuote(nvimBinary()), ...args.map(shellQuote)].join(" ");
}

async function runNvim(pi: ExtensionAPI, args: string[], timeout = 5_000) {
	const result = await pi.exec(nvimBinary(), args, { timeout });
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Neovim exited with code ${result.code}.`);
	return result;
}

async function isNvimLive(pi: ExtensionAPI, socket: string): Promise<boolean> {
	try {
		await runNvim(pi, ["--server", socket, "--remote-expr", "1"], 2_000);
		return true;
	} catch {
		return false;
	}
}

async function removeStaleSocket(socket: string): Promise<void> {
	try {
		const entry = await lstat(socket);
		if (entry.isSocket()) await unlink(socket);
	} catch {
		// The socket does not exist or disappeared between checks.
	}
}

async function refreshNvim(pi: ExtensionAPI, root: string): Promise<{ refreshed: boolean; socket: string }> {
	const socket = nvimSocket(root);
	if (!await isNvimLive(pi, socket)) return { refreshed: false, socket };
	await runNvim(pi, ["--server", socket, "--remote-send", "<C-\\><C-N>:checktime<CR>"]);
	return { refreshed: true, socket };
}

async function openViewerInHerdr(pi: ExtensionAPI, readOnly: boolean) {
	const root = await configuredNotes().getRoot();
	const socket = nvimSocket(root);
	if (await isNvimLive(pi, socket)) return textResult(`Neovim is already open for ${root}.`, { opened: true, root, socket, alreadyOpen: true });
	await removeStaleSocket(socket);
	const command = viewerCommand(root, socket, readOnly);
	const herdrToolAvailable = typeof pi.getAllTools === "function" && pi.getAllTools().some((tool) => tool.name === "herdr_shell");
	if (process.env.HERDR_ENV !== "1" || !herdrToolAvailable) {
		return textResult(`Herdr is unavailable in this Pi session. Run this in a VM terminal instead:\n${command}`, { opened: false, root, command });
	}

	const result = await new Promise<{ ok: boolean; error?: string }>((resolveResult) => {
		let settled = false;
		const finish = (value: { ok: boolean; error?: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveResult(value);
		};
		const timeout = setTimeout(() => finish({ ok: false, error: "Timed out waiting for the Herdr pane manager." }), 20_000);
		try {
			pi.events.emit("herdr:open-command", { command, cwd: root, respond: finish });
		} catch (error) {
			finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	if (!result.ok) return textResult(`Could not open the Herdr pane: ${result.error ?? "unknown error"}\nRun this in a VM terminal instead:\n${command}`, { opened: false, root, command, error: result.error });
	return textResult(`Opened Neovim in a right-side Herdr pane for ${root}.`, { opened: true, root, socket, command });
}

async function runGit(pi: ExtensionAPI, root: string, args: string[], timeout = 15_000) {
	const result = await pi.exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, timeout });
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed with code ${result.code}.`);
	return result.stdout.trimEnd();
}

async function runGitAction(pi: ExtensionAPI, action: "status" | "diff" | "commit", message?: string) {
	const root = await configuredNotes().getRoot();
	if (action === "status") return textResult(await runGit(pi, root, ["status", "--short", "--branch"]), { action, root });
	if (action === "diff") {
		const output = await runGit(pi, root, ["diff", "--no-ext-diff", "HEAD", "--", "*.md"]);
		return textResult(truncateUtf8(output || "No Markdown changes.").text, { action, root });
	}
	const commitMessage = message?.trim();
	if (!commitMessage) throw new Error("notes_git commit requires a non-empty message.");
	await runGit(pi, root, ["add", "--", "*.md"]);
	const staged = await pi.exec("git", ["-c", "core.hooksPath=/dev/null", "diff", "--cached", "--quiet", "--exit-code", "--", "*.md"], { cwd: root, timeout: 5_000 });
	if (staged.code === 0) return textResult("No Markdown changes to commit.", { action, root, committed: false });
	if (staged.code !== 1) throw new Error(staged.stderr.trim() || "Could not inspect staged Markdown changes.");
	return textResult(await runGit(pi, root, ["commit", "--no-verify", "-m", commitMessage]), { action, root, committed: true });
}

function truncateUtf8(text: string, maxBytes = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	const suffix = `\n\n[Output truncated to ${maxBytes} bytes.]`;
	let result = text.slice(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
	while (Buffer.byteLength(result, "utf8") + Buffer.byteLength(suffix, "utf8") > maxBytes) result = result.slice(0, -1);
	return { text: `${result}${suffix}`, truncated: true };
}

export default function notesExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "notes_list",
		label: "List Notes",
		description: "List Markdown notes in the configured local notes directory. Hidden directories are excluded. The directory is configured with NOTES_PATH.",
		promptSnippet: "List Markdown notes in the configured notes directory",
		promptGuidelines: ["Use notes_list to discover notes instead of guessing note paths.", "Notes tools only access the directory configured by NOTES_PATH."],
		parameters: listNotesParameters,
		async execute(_toolCallId, params) {
			const notes = await configuredNotes().listNotes(params.path ?? ".", params.limit ?? 100);
			const text = notes.length ? notes.map((note) => `${note.path} (${note.bytes} bytes, modified ${note.modifiedAt})`).join("\n") : "No Markdown notes found.";
			const output = truncateUtf8(text);
			return textResult(output.text, { notes, truncated: output.truncated });
		},
	});

	pi.registerTool({
		name: "notes_search",
		label: "Search Notes",
		description: "Run a bounded grep-like search in visible Markdown notes. Literal mode (default) searches content and filenames; regex searches content line-by-line with a timeout; filename mode searches paths only. Supports path-relative globs, case sensitivity, context lines, and path-only output.",
		promptSnippet: "Search note content and filenames with bounded grep-like options",
		promptGuidelines: ["Use notes_search before reading notes when you need to locate information by topic or phrase.", "Use mode regex for patterns, filename for path-only discovery, and glob/path to narrow the search.", "Use pathsOnly when you only need matching paths; use contextLines sparingly to keep output small.", "Use notes_read after notes_search when a matching note needs fuller context."],
		parameters: searchParameters,
		async execute(_toolCallId, params, signal) {
			const matches = await configuredNotes().search(params.query, params.path ?? ".", params.limit ?? 20, {
				mode: params.mode as NotesSearchMode | undefined,
				glob: params.glob,
				caseSensitive: params.caseSensitive,
				contextLines: params.contextLines,
				pathsOnly: params.pathsOnly,
				signal,
			});
			const text = matches.length
				? params.pathsOnly
					? matches.map((match) => match.path).join("\n")
					: matches.map((match) => `${match.path}${match.line ? `:${match.line}` : ""}${match.snippet ? `\n${match.snippet}` : ""}`).join("\n\n")
				: `No notes matched: ${params.query}`;
			const output = truncateUtf8(text);
			return textResult(output.text, { query: params.query, matches, truncated: output.truncated });
		},
	});

	pi.registerTool({
		name: "notes_read",
		label: "Read Note",
		description: `Read one Markdown note from the configured local notes directory. Notes larger than ${MAX_NOTE_BYTES} bytes are rejected and output is bounded to 50KB.`,
		promptSnippet: "Read a Markdown note",
		parameters: readNoteParameters,
		async execute(_toolCallId, params) {
			const note = await configuredNotes().readNote(params.path);
			const output = truncateUtf8(note.content);
			return textResult(output.text, { path: note.path, bytes: note.bytes, truncated: output.truncated });
		},
	});

	pi.registerTool({
		name: "notes_write",
		label: "Write Note",
		description: `Create, overwrite, or append to a Markdown note in the configured local notes directory. Writes are path-confined and limited to ${MAX_NOTE_BYTES} bytes. Use create for new notes and choose overwrite or append explicitly for existing notes.`,
		promptSnippet: "Create or update a Markdown note",
		promptGuidelines: ["Use notes_write only when the user asks to create or update note content.", "Use notes_transfer for copy/move operations so unchanged content is not sent through the model.", "Choose notes_write mode explicitly: create refuses existing notes, overwrite replaces them, and append preserves existing content.", "Never put secrets, credentials, or private keys into notes_write unless the user explicitly requests that exact content."],
		parameters: writeNoteParameters,
		async execute(_toolCallId, params) {
			const result = await configuredNotes().writeNote(params.path, params.content, params.mode as NotesWriteMode);
			const verb = result.mode === "create" ? "Created" : result.mode === "overwrite" ? "Overwrote" : "Appended to";
			return textResult(`${verb} ${result.path} (${result.bytes} bytes).`, { result });
		},
	});

	pi.registerTool({
		name: "notes_transfer",
		label: "Move or Copy Note",
		description: "Copy or move an existing Markdown note by path inside the configured notes directory. This performs a local filesystem operation without reading or rewriting note content; destination files are never overwritten.",
		promptSnippet: "Move or copy a Markdown note without transferring its content",
		promptGuidelines: ["Use notes_transfer for relocations or duplicates so note content does not spend model tokens.", "Use action move to rename/relocate and copy to duplicate; source and destination must be Markdown paths.", "The operation creates missing destination folders and refuses existing destinations; use notes_write only for semantic content changes."],
		parameters: transferNoteParameters,
		async execute(_toolCallId, params) {
			const result = await configuredNotes().transferNote(params.source, params.destination, params.action as NotesTransferAction);
			const verb = result.action === "copy" ? "Copied" : "Moved";
			return textResult(`${verb} ${result.source} to ${result.destination} (${result.bytes} bytes).`, { result });
		},
	});

	pi.registerTool({
		name: "notes_open_viewer",
		label: "Open Notes in Neovim",
		description: "Open Neovim with the notes directory in a right-side Herdr pane when available. Otherwise return the command for a normal VM terminal.",
		promptSnippet: "Open the notes directory in Neovim in a Herdr side pane",
		promptGuidelines: ["Use notes_open_viewer when the user wants to browse or edit notes interactively alongside Pi.", "notes_open_viewer uses a clean, local Neovim configuration and never exposes notes over a network."],
		parameters: openViewerParameters,
		async execute(_toolCallId, params) {
			return openViewerInHerdr(pi, params.readOnly === true);
		},
	});

	pi.registerTool({
		name: "notes_open_note",
		label: "Open Note in Neovim",
		description: "Open a validated Markdown note in the running Notes Neovim instance.",
		parameters: openNoteParameters,
		async execute(_toolCallId, params) {
			const vault = configuredNotes();
			const root = await vault.getRoot();
			const notePath = await vault.resolveNoteFile(params.path);
			const socket = nvimSocket(root);
			if (!await isNvimLive(pi, socket)) throw new Error("Neovim is not running. Use notes_open_viewer first.");
			await runNvim(pi, ["--server", socket, "--remote", notePath]);
			return textResult(`Opened ${params.path} in Neovim.`, { opened: true, path: params.path, socket });
		},
	});

	pi.registerTool({
		name: "notes_refresh",
		label: "Refresh Neovim Notes",
		description: "Ask the running Neovim instance to detect notes changed by Pi or another process.",
		parameters: Type.Object({}),
		async execute() {
			const root = await configuredNotes().getRoot();
			const result = await refreshNvim(pi, root);
			return textResult(result.refreshed ? "Neovim refreshed changed files." : "Neovim is not running. Use notes_open_viewer first.", result);
		},
	});

	pi.registerTool({
		name: "notes_save",
		label: "Save Neovim Note",
		description: "Save the current Neovim buffer. Use explicitly because it can write unsaved human edits.",
		parameters: Type.Object({}),
		async execute() {
			const root = await configuredNotes().getRoot();
			const socket = nvimSocket(root);
			if (!await isNvimLive(pi, socket)) throw new Error("Neovim is not running. Use notes_open_viewer first.");
			await runNvim(pi, ["--server", socket, "--remote-send", "<C-\\><C-N>:update<CR>"]);
			return textResult("Saved the current Neovim buffer.", { saved: true, socket });
		},
	});

	pi.registerTool({
		name: "notes_git",
		label: "Notes Git",
		description: "Run one explicit local Git operation against the notes repository. Uses direct git arguments, disables repository hooks, and has no remote synchronization.",
		promptSnippet: "Check or checkpoint the local notes Git repository",
		promptGuidelines: ["Use notes_git status before creating a local checkpoint.", "Use notes_git diff to review Markdown changes.", "Use notes_git commit with an explicit message; only Markdown files are staged."],
		parameters: gitParameters,
		async execute(_toolCallId, params) {
			return runGitAction(pi, params.action, params.message);
		},
	});

	pi.registerCommand("notes", {
		description: "Show the configured notes directory",
		handler: async (_args, ctx) => {
			try {
				const root = await configuredNotes().getRoot();
				ctx.ui.notify(`Notes directory: ${root}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerCommand("notes-open", {
		description: "Open the Notes directory in Neovim",
		handler: async (args, ctx) => {
			try {
				const result = await openViewerInHerdr(pi, args.trim() === "--read-only");
				const text = result.content.find((part) => part.type === "text")?.text ?? "Notes Neovim request completed.";
				ctx.ui.notify(text, result.details?.opened === true ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});
}
