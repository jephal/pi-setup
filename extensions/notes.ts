import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import {
	NotesVault,
	MAX_NOTE_BYTES,
	type NotesWriteMode,
} from "../src/notes/vault.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_LIST_LIMIT = 500;

const listNotesParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Folder inside the notes directory to list (default: root)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: "Maximum number of notes to return (default: 100)" })),
});

const searchParameters = Type.Object({
	query: Type.String({ description: "Text to find in note content or filenames" }),
	path: Type.Optional(Type.String({ description: "Folder inside the notes directory to search (default: root)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum number of matching notes (default: 20)" })),
});

const openViewerParameters = Type.Object({
	readOnly: Type.Optional(Type.Boolean({ description: "Open the Notes viewer in read-only mode" })),
});

const gitParameters = Type.Object({
	action: StringEnum(["status", "diff", "commit"] as const, {
		description: "Explicit local Git operation for the notes repository",
	}),
	message: Type.Optional(Type.String({ description: "Commit message, required for commit" })),
});

const readNoteParameters = Type.Object({
	path: Type.String({ description: "Markdown note path relative to the notes directory" }),
});

const writeNoteParameters = Type.Object({
	path: Type.String({ description: "Markdown note path relative to the notes directory" }),
	content: Type.String({ description: "Complete note content, or content to append" }),
	mode: StringEnum(["create", "overwrite", "append"] as const, {
		description: "create a new note, overwrite an existing note, or append to an existing note",
	}),
});

function configuredNotes(): NotesVault {
	return NotesVault.fromEnvironment();
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function viewerCommand(root: string, readOnly: boolean): string {
	const viewerPath = fileURLToPath(new URL("../src/notes/tui.mjs", import.meta.url));
	return [shellQuote(process.execPath), shellQuote(viewerPath), "--notes", shellQuote(root), readOnly ? "--read-only" : ""].filter(Boolean).join(" ");
}

async function openViewerInHerdr(pi: ExtensionAPI, readOnly: boolean) {
	const root = await configuredNotes().getRoot();
	const command = viewerCommand(root, readOnly);
	const herdrToolAvailable = typeof pi.getAllTools === "function" && pi.getAllTools().some((tool) => tool.name === "herdr_shell");
	if (process.env.HERDR_ENV !== "1" || !herdrToolAvailable) {
		return textResult(`Herdr is unavailable in this Pi session. Run this in a VM terminal instead:\n${command}`, {
			opened: false,
			root,
			command,
		});
	}

	const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
		let settled = false;
		const finish = (value: { ok: boolean; error?: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(value);
		};
		const timeout = setTimeout(() => finish({ ok: false, error: "Timed out waiting for the Herdr pane manager." }), 20_000);
		try {
			pi.events.emit("herdr:open-command", { command, cwd: root, respond: finish });
		} catch (error) {
			finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	if (!result.ok) {
		return textResult(`Could not open the Herdr pane: ${result.error ?? "unknown error"}\nRun this in a VM terminal instead:\n${command}`, {
			opened: false,
			root,
			command,
			error: result.error,
		});
	}
	return textResult(`Opened the Notes viewer in a right-side Herdr pane for ${root}.`, { opened: true, root, command });
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
	if (action === "commit") {
		const commitMessage = message?.trim();
		if (!commitMessage) throw new Error("notes_git commit requires a non-empty message.");
		await runGit(pi, root, ["add", "--", "*.md"]);
		const staged = await pi.exec("git", ["-c", "core.hooksPath=/dev/null", "diff", "--cached", "--quiet", "--exit-code", "--", "*.md"], { cwd: root, timeout: 5_000 });
		if (staged.code === 0) return textResult("No Markdown changes to commit.", { action, root, committed: false });
		if (staged.code !== 1) throw new Error(staged.stderr.trim() || "Could not inspect staged Markdown changes.");
		return textResult(await runGit(pi, root, ["commit", "--no-verify", "-m", commitMessage]), { action, root, committed: true });
	}
	throw new Error(`Unsupported local notes Git operation: ${action}`);
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
		promptGuidelines: [
			"Use notes_list to discover notes instead of guessing note paths.",
			"Notes tools only access the directory configured by NOTES_PATH.",
		],
		parameters: listNotesParameters,
		async execute(_toolCallId, params) {
			const notes = await configuredNotes().listNotes(params.path ?? ".", params.limit ?? 100);
			const text = notes.length
				? notes.map((note) => `${note.path} (${note.bytes} bytes, modified ${note.modifiedAt})`).join("\n")
				: "No Markdown notes found.";
			const output = truncateUtf8(text);
			return textResult(output.text, { notes, truncated: output.truncated });
		},
	});

	pi.registerTool({
		name: "notes_search",
		label: "Search Notes",
		description: "Search note content and filenames in the configured local notes directory. Returns the first matching line for each note, with bounded results.",
		promptSnippet: "Search note content and filenames",
		promptGuidelines: [
			"Use notes_search before reading notes when you need to locate information by topic or phrase.",
			"Use notes_read after notes_search when the matching note needs fuller context.",
		],
		parameters: searchParameters,
		async execute(_toolCallId, params) {
			const matches = await configuredNotes().search(params.query, params.path ?? ".", params.limit ?? 20);
			const text = matches.length
				? matches.map((match) => `${match.path}${match.line ? `:${match.line}` : ""}\n${match.snippet}`).join("\n\n")
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
		promptGuidelines: [
			"Use notes_write only when the user asks to create or update a note.",
			"Choose notes_write mode explicitly: create refuses existing notes, overwrite replaces them, and append preserves existing content.",
			"Never put secrets, credentials, or private keys into notes_write unless the user explicitly requests that exact content.",
		],
		parameters: writeNoteParameters,
		async execute(_toolCallId, params) {
			const result = await configuredNotes().writeNote(params.path, params.content, params.mode as NotesWriteMode);
			const verb = result.mode === "create" ? "Created" : result.mode === "overwrite" ? "Overwrote" : "Appended to";
			return textResult(`${verb} ${result.path} (${result.bytes} bytes).`, { result });
		},
	});

	pi.registerTool({
		name: "notes_open_viewer",
		label: "Open Notes Viewer",
		description: "Open the dependency-free terminal Notes viewer in a right-side Herdr pane when available. Otherwise return the command for a normal VM terminal.",
		promptSnippet: "Open the terminal Notes viewer in a Herdr side pane",
		promptGuidelines: [
			"Use notes_open_viewer when the user wants to browse the notes directory interactively alongside Pi.",
			"notes_open_viewer uses Herdr when Pi is running inside Herdr and never exposes the notes directory over a network.",
		],
		parameters: openViewerParameters,
		async execute(_toolCallId, params) {
			return openViewerInHerdr(pi, params.readOnly === true);
		},
	});

	pi.registerTool({
		name: "notes_git",
		label: "Notes Git",
		description: "Run one explicit local Git operation against the notes repository. Uses direct git arguments, disables repository hooks, and has no remote synchronization.",
		promptSnippet: "Check or checkpoint the local notes Git repository",
		promptGuidelines: [
			"Use notes_git status before creating a local checkpoint.",
			"Use notes_git diff to review Markdown changes.",
			"Use notes_git commit with an explicit message; only Markdown files are staged.",
		],
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
		description: "Open the terminal Notes viewer in a Herdr pane",
		handler: async (args, ctx) => {
			try {
				const result = await openViewerInHerdr(pi, args.trim() === "--read-only");
				const text = result.content.find((part) => part.type === "text")?.text ?? "Notes viewer request completed.";
				ctx.ui.notify(text, result.details?.opened === true ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});
}
