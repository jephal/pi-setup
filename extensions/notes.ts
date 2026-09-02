import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotesVault, MAX_NOTE_BYTES, type NotesSearchMode, type NotesTransferAction, type NotesWriteMode } from "../src/notes/vault.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_LIST_LIMIT = 500;
const OPTIONAL_ADMIN_TOOLS = {
	open_note: "notes_open_note",
	refresh: "notes_refresh",
	save: "notes_save",
	git: "notes_git",
} as const;

const listNotesParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Optional folder relative to the configured notes vault, not the current project. Omit this or use '.' to list the whole vault; an empty value is treated as the vault root." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: "Maximum number of notes to return (default: 100)" })),
});

const searchParameters = Type.Object({
	query: Type.String({ description: "Literal text or regular expression to find" }),
	path: Type.Optional(Type.String({ description: "Optional folder relative to the configured notes vault, not the current project. Omit this or use '.' to search the whole vault; an empty value is treated as the vault root." })),
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

const notesAdminParameters = Type.Object({
	action: StringEnum(["open_note", "refresh", "save", "git"] as const, {
		description: "Optional Notes administration capability to activate",
	}),
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

type SocketProbe = "live" | "dead" | "unknown";

/**
 * A remote Neovim expression can time out while the server is healthy (for
 * example while its UI is busy). Socket reachability is therefore the only
 * authority used before deleting a stale pathname.
 */
export async function probeNotesSocket(socketPath: string, timeoutMs = 500): Promise<SocketProbe> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const socket = net.createConnection({ path: socketPath });
		const finish = (result: SocketProbe) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};
		timer = setTimeout(() => finish("unknown"), timeoutMs);
		timer.unref();
		socket.unref();
		socket.once("connect", () => finish("live"));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			// Only connection outcomes which establish that no server accepted the
			// endpoint are safe to unlink. Permissions and all other errors retain
			// the pathname for a human or a later attempt to inspect.
			finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET" ? "dead" : "unknown");
		});
	});
}

export async function removeStaleSocket(socket: string): Promise<void> {
	let entry;
	try { entry = await lstat(socket); }
	catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
		return; // Permission and unknown filesystem failures are conservative.
	}
	if (!entry.isSocket()) return;
	// Do not unlink another local user's socket even in a shared runtime dir.
	if (typeof process.getuid === "function" && entry.uid !== process.getuid()) return;
	if (await probeNotesSocket(socket) !== "dead") return;
	try { await unlink(socket); }
	catch { /* The server may have replaced or removed it after the probe. */ }
}

async function remoteNvimExpr(pi: ExtensionAPI, socket: string, expression: string, action: string): Promise<string> {
	try {
		const result = await runNvim(pi, ["--server", socket, "--remote-expr", expression]);
		return result.stdout.trim();
	} catch (error) {
		throw new Error(`Neovim ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function refreshNvim(pi: ExtensionAPI, root: string): Promise<{ refreshed: boolean; socket: string; conflict?: "dirty"; message?: string }> {
	const socket = nvimSocket(root);
	if (!await isNvimLive(pi, socket)) return { refreshed: false, socket };
	// Do not call checktime against a dirty human buffer. For a clean buffer,
	// schedule it in Neovim so this RPC returns promptly; checktime itself still
	// preserves edits if the buffer becomes modified before it runs.
	const status = await remoteNvimExpr(pi, socket, "luaeval(\"pi_notes_refresh()\")", "refresh");
	if (status === "dirty") return { refreshed: false, socket, conflict: "dirty" };
	if (status !== "scheduled") throw new Error(`Neovim refresh failed: ${status || "unexpected response"}`);
	return { refreshed: true, socket };
}

async function saveNvim(pi: ExtensionAPI, socket: string): Promise<void> {
	const status = await remoteNvimExpr(pi, socket, "luaeval(\"pi_notes_save()\")", "save");
	if (status === "saved") return;
	if (status === "read_only") throw new Error("Neovim save was not performed because the current buffer is read-only.");
	if (status === "not_saved") throw new Error("Neovim did not save the current buffer; its edits remain unsaved.");
	throw new Error(`Neovim save failed: ${status || "unexpected response"}`);
}

async function viewerLockOwnerIsAlive(pid: unknown): Promise<boolean> {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"); }
}

/** Detach before removal so a newly acquired lock is never recursively removed. */
async function reclaimViewerLock(lock: string): Promise<void> {
	const detached = `${lock}.stale-${process.pid}-${randomUUID()}`;
	try { await rename(lock, detached); }
	catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	await rm(detached, { recursive: true, force: true });
}

async function staleViewerLock(lock: string): Promise<boolean> {
	try {
		const entry = await lstat(lock);
		if (!entry.isDirectory() || Date.now() - entry.mtimeMs <= 30_000) return false;
		try {
			const owner = JSON.parse(await readFile(`${lock}/owner.json`, "utf8")) as { pid?: unknown; createdAt?: unknown };
			const createdAt = typeof owner.createdAt === "number" ? owner.createdAt : entry.mtimeMs;
			return Date.now() - createdAt > 30_000 && !await viewerLockOwnerIsAlive(owner.pid);
		} catch (error) {
			// An incomplete abandoned lock can be recovered; permission failures
			// cannot establish ownership loss and must remain untouched.
			if (typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) return false;
			return true;
		}
	} catch { return false; }
}

export async function acquireViewerLock(socket: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	const lock = `${socket}.launch`;
	const deadline = Date.now() + 12_000;
	while (true) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Notes viewer request was cancelled.");
		try {
			await mkdir(lock, { mode: 0o700 });
			const token = randomUUID();
			const ownerPath = `${lock}/owner.json`;
			try { await writeFile(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), { mode: 0o600 }); }
			catch (error) {
				await unlink(ownerPath).catch(() => undefined);
				await rmdir(lock).catch(() => undefined);
				throw error;
			}
			return async () => {
				const detached = `${lock}.release-${token}`;
				try { await rename(lock, detached); }
				catch { return; }
				try {
					const owner = JSON.parse(await readFile(`${detached}/owner.json`, "utf8")) as { token?: unknown };
					if (owner.token !== token) {
						// A replacement won the race before the detach. Put it back only
						// if another launcher has not already created a newer lock.
						await rename(detached, lock).catch(() => undefined);
						return;
					}
					await unlink(`${detached}/owner.json`);
					// These operations affect only our detached directory and are
					// non-recursive, so no recreated lock can be deleted.
					await rmdir(detached);
				} catch { /* reclaimed, replaced, or still in use: never delete recursively */ }
			};
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			if (await staleViewerLock(lock)) await reclaimViewerLock(lock);
			if (Date.now() >= deadline) throw new Error("Timed out waiting for another Notes viewer launch.");
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(done, 100);
				const abort = () => done(signal?.reason instanceof Error ? signal.reason : new Error("Notes viewer request was cancelled."));
				function done(reason?: Error) { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (reason) reject(reason); else resolve(); }
				if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}
}

async function requestNotesViewer(pi: ExtensionAPI, root: string, socket: string, command: string | undefined, signal?: AbortSignal) {
	return new Promise<{ ok: boolean; error?: string; binding?: Record<string, unknown>; existing?: boolean }>((resolveResult) => {
		const controller = new AbortController();
		let settled = false;
		const abort = () => {
			controller.abort(signal?.reason);
			finish({ ok: false, error: "Notes viewer request was cancelled." });
		};
		const finish = (value: { ok: boolean; error?: string; binding?: Record<string, unknown>; existing?: boolean }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolveResult(value);
		};
		const timeout = setTimeout(() => {
			controller.abort(new Error("Timed out waiting for the Herdr pane manager."));
			finish({ ok: false, error: "Timed out waiting for the Herdr pane manager." });
		}, 20_000);
		timeout.unref();
		if (signal?.aborted) { abort(); finish({ ok: false, error: "Notes viewer request was cancelled." }); return; }
		signal?.addEventListener("abort", abort, { once: true });
		try { pi.events.emit("herdr:open-command", { role: "notes-viewer", command, cwd: root, socket, signal: controller.signal, respond: finish }); }
		catch (error) { controller.abort(error); finish({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
	});
}

async function openViewerInHerdr(pi: ExtensionAPI, readOnly: boolean, signal?: AbortSignal) {
	const root = await configuredNotes().getRoot();
	const socket = nvimSocket(root);
	const command = viewerCommand(root, socket, readOnly);
	const herdrToolAvailable = typeof pi.getAllTools === "function" && pi.getAllTools().some((tool) => tool.name === "herdr_shell");
	if (process.env.HERDR_ENV !== "1" || !herdrToolAvailable) return textResult(`Herdr is unavailable in this Pi session. Run this in a VM terminal instead:\n${command}`, { opened: false, root, command });

	// Ask the separate notes ownership path to locate a live viewer even when it
	// was opened from another Pi session, workspace, or tab.
	if (await isNvimLive(pi, socket)) {
		const located = await requestNotesViewer(pi, root, socket, undefined, signal);
		if (located.ok) return textResult(`Neovim is already open for ${root}.`, { opened: true, root, socket, alreadyOpen: true, binding: located.binding, existing: located.existing });
		return textResult(`Neovim is already open for ${root}, but its Herdr location could not be confirmed: ${located.error ?? "unknown error"}.`, { opened: true, root, socket, alreadyOpen: true, error: located.error });
	}
	const release = await acquireViewerLock(socket, signal);
	try {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Notes viewer request was cancelled.");
		if (await isNvimLive(pi, socket)) {
			const located = await requestNotesViewer(pi, root, socket, undefined, signal);
			return textResult(`Neovim is already open for ${root}.`, { opened: true, root, socket, alreadyOpen: true, binding: located.binding });
		}
		await removeStaleSocket(socket);
		const result = await requestNotesViewer(pi, root, socket, command, signal);
		if (!result.ok) return textResult(`Could not open the Herdr pane: ${result.error ?? "unknown error"}\nRun this in a VM terminal instead:\n${command}`, { opened: false, root, command, error: result.error });
		return textResult(`Opened Neovim in Herdr pane ${String(result.binding?.paneId ?? "unknown")} for ${root}.`, { opened: true, root, socket, command, binding: result.binding, existing: result.existing });
	} finally { await release(); }
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

function activateOptionalNotesTool(pi: ExtensionAPI, action: keyof typeof OPTIONAL_ADMIN_TOOLS): string {
	const toolName = OPTIONAL_ADMIN_TOOLS[action];
	const activeTools = pi.getActiveTools();
	if (!activeTools.includes(toolName)) pi.setActiveTools([...activeTools, toolName]);
	return toolName;
}

export default function notesExtension(pi: ExtensionAPI): void {
	// Keep administration-only tools out of the default prompt. This is applied
	// once per session; the small loader only adds a requested capability.
	pi.on("session_start", () => {
		const optional = new Set<string>(Object.values(OPTIONAL_ADMIN_TOOLS));
		const activeTools = pi.getActiveTools();
		const reduced = activeTools.filter((name) => !optional.has(name));
		if (reduced.length !== activeTools.length) pi.setActiveTools(reduced);
	});

	pi.registerTool({
		name: "notes_list",
		label: "List Notes",
		description: "List visible Markdown notes in the configured NOTES_PATH vault; this is independent of the current project directory and hidden folders are excluded.",
		promptSnippet: "List Markdown notes in the configured notes vault",
		promptGuidelines: ["List notes before guessing a note path.", "The notes vault is configured by NOTES_PATH and is separate from the current project; omit path or use '.' for its root, never pass the project directory."],
		parameters: listNotesParameters,
		async execute(_toolCallId, params) {
			const notes = await configuredNotes().listNotes(params.path?.trim() || ".", params.limit ?? 100);
			const text = notes.length ? notes.map((note) => `${note.path} (${note.bytes} bytes, modified ${note.modifiedAt})`).join("\n") : "No Markdown notes found.";
			const output = truncateUtf8(text);
			return textResult(output.text, { notes, truncated: output.truncated });
		},
	});

	pi.registerTool({
		name: "notes_search",
		label: "Search Notes",
		description: "Bounded grep-like search over the configured NOTES_PATH vault, independent of the current project: literal searches content and names, regex is line-based and timed, filename searches paths only.",
		promptSnippet: "Search the configured notes vault",
		promptGuidelines: ["Search before reading; use pathsOnly for discovery and notes_read for full context.", "The notes vault is configured by NOTES_PATH and is separate from the current project; omit path or use '.' for its root, never pass the project directory."],
		parameters: searchParameters,
		async execute(_toolCallId, params, signal) {
			const matches = await configuredNotes().search(params.query, params.path?.trim() || ".", params.limit ?? 20, {
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
		description: `Create, overwrite, or append a path-confined Markdown note (max ${MAX_NOTE_BYTES} bytes).`,
		promptSnippet: "Create or update a Markdown note",
		promptGuidelines: ["Write only user-requested content; use transfer for moves or copies.", "Choose create for new files; overwrite replaces and append preserves existing content.", "Never put secrets, credentials, or private keys into a note unless explicitly requested."],
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
		description: "Copy or move a Markdown note inside the configured directory without reading its content; destinations are never overwritten.",
		promptSnippet: "Move or copy a note without transferring its content",
		promptGuidelines: ["Use for relocations or duplicates; use notes_write only for content changes."],
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
		description: "Open the notes directory in a right-side Herdr Neovim pane, or return a local terminal command when Herdr is unavailable.",
		promptSnippet: "Open notes in a Herdr-side Neovim pane",
		promptGuidelines: ["Use when the user wants to browse or edit notes alongside Pi."],
		parameters: openViewerParameters,
		async execute(_toolCallId, params, signal) {
			return openViewerInHerdr(pi, params.readOnly === true, signal);
		},
	});

	pi.registerTool({
		name: "notes_admin_tools",
		label: "Notes: Activate Admin Tool",
		description: "Activate one optional Notes administration tool when the current task needs it.",
		promptSnippet: "Activate optional Notes administration tools only when needed",
		promptGuidelines: [
			"Select open_note only after notes_open_viewer is running and a specific validated note should be shown.",
			"Select refresh only to make the running Notes Neovim instance check external file changes.",
			"Select save only when the user explicitly wants to write the current Neovim buffer.",
			"Select git only for explicit local notes-repository status, diff, or checkpoint work; it never synchronizes a remote.",
		],
		parameters: notesAdminParameters,
		async execute(_toolCallId, params) {
			const toolName = activateOptionalNotesTool(pi, params.action as keyof typeof OPTIONAL_ADMIN_TOOLS);
			return textResult(`Activated ${toolName}.`, { action: params.action, toolName });
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
			const text = result.refreshed
				? "Neovim scheduled a safe check for changed files."
				: result.conflict === "dirty"
					? "Neovim did not refresh because the current buffer has unsaved edits; those edits were preserved."
					: "Neovim is not running. Use notes_open_viewer first.";
			return textResult(text, result);
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
			await saveNvim(pi, socket);
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
