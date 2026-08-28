import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { ensureFrontmatter } from "./frontmatter.ts";
import { constants } from "node:fs";
import { Worker } from "node:worker_threads";
import { copyFile, link, mkdir, lstat, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const MAX_NOTE_BYTES = 5 * 1024 * 1024;
export const MAX_SEARCH_FILES = 5_000;
const MAX_REGEX_QUERY_CHARS = 256;
const REGEX_MATCH_TIMEOUT_MS = 250;
const MAX_SEARCH_DURATION_MS = 30_000;
const MAX_SNIPPET_LINE_CHARS = 500;
const MAX_GLOB_CHARS = 256;

export interface NotesNote {
	path: string;
	bytes: number;
	modifiedAt: string;
}

export interface NotesSearchMatch {
	path: string;
	line?: number;
	snippet: string;
}

export type NotesSearchMode = "literal" | "regex" | "filename";

export interface NotesSearchOptions {
	mode?: NotesSearchMode;
	glob?: string;
	caseSensitive?: boolean;
	contextLines?: number;
	pathsOnly?: boolean;
	signal?: AbortSignal;
}

export type NotesWriteMode = "create" | "overwrite" | "append";

export interface NotesWriteResult {
	path: string;
	mode: NotesWriteMode;
	bytes: number;
}

export type NotesTransferAction = "copy" | "move";

export interface NotesTransferResult {
	action: NotesTransferAction;
	source: string;
	destination: string;
	bytes: number;
}

export class NotesVault {
	private readonly configuredPath: string;

	constructor(vaultPath: string) {
		if (!vaultPath.trim()) throw new Error("Notes vault path cannot be empty.");
		this.configuredPath = vaultPath;
	}

	static fromEnvironment(): NotesVault {
		const vaultPath = process.env.NOTES_PATH;
		if (!vaultPath) {
			throw new Error(
				"Notes path is not configured. Set NOTES_PATH to the local notes directory.",
			);
		}
		return new NotesVault(vaultPath);
	}

	async getRoot(): Promise<string> {
		const root = await realpath(this.configuredPath).catch(() => {
			throw new Error(`Notes vault is unavailable: ${this.configuredPath}`);
		});
		const rootStat = await stat(root);
		if (!rootStat.isDirectory()) throw new Error(`Notes vault is not a directory: ${root}`);
		return root;
	}

	async listNotes(directory = ".", limit = 100): Promise<NotesNote[]> {
		const boundedLimit = boundLimit(limit);
		const root = await this.getRoot();
		const start = await this.resolveDirectory(root, directory);
		const notes: NotesNote[] = [];
		await this.walkNotes(start, root, notes, boundedLimit);
		return notes;
	}

	async search(query: string, directory = ".", limit = 20, options: NotesSearchOptions = {}): Promise<NotesSearchMatch[]> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) throw new Error("Search query cannot be empty.");

		const mode = options.mode ?? "literal";
		if (mode !== "literal" && mode !== "regex" && mode !== "filename") {
			throw new Error(`Unsupported Notes search mode: ${mode}`);
		}
		const boundedLimit = Math.min(boundLimit(limit), 100);
		const contextLines = boundContextLines(options.contextLines);
		const deadline = Date.now() + MAX_SEARCH_DURATION_MS;
		if (mode === "regex") validateRegex(normalizedQuery, options.caseSensitive === true);
		const root = await this.getRoot();
		const start = await this.resolveDirectory(root, directory);
		const matches: NotesSearchMatch[] = [];
		const matchesText = mode === "regex" ? undefined : createSearchMatcher(normalizedQuery, options.caseSensitive === true);
		const matchesGlob = createGlobMatcher(options.glob);
		const regexSearch = mode === "regex" ? new RegexSearchWorker(normalizedQuery, options.caseSensitive === true) : undefined;
		let filesVisited = 0;

		try {
			for await (const notePath of this.walkNotePaths(start, root)) {
				if (options.signal?.aborted) throw new Error("Notes search was cancelled.");
				if (Date.now() > deadline) throw new Error(`Notes search exceeded ${MAX_SEARCH_DURATION_MS}ms; narrow the path or query.`);
				if (matches.length >= boundedLimit) break;
				if (++filesVisited > MAX_SEARCH_FILES) break;
				const absolutePath = join(root, ...notePath.split("/"));
				const scopedPath = relative(start, absolutePath).split(sep).join("/");
				if (!matchesGlob(scopedPath)) continue;

				if (mode === "filename") {
					if (matchesText!(notePath) < 0) continue;
					matches.push({ path: notePath, snippet: options.pathsOnly ? "Path match" : "Filename match" });
					continue;
				}

				const filenameIndex = mode === "literal" ? matchesText!(notePath) : -1;
				const noteStat = await lstat(absolutePath);
				if (noteStat.size > MAX_NOTE_BYTES) continue;
				if (options.pathsOnly && filenameIndex >= 0) {
					matches.push({ path: notePath, snippet: "Path match" });
					continue;
				}

				const content = await readFile(absolutePath, "utf8");
				const contentIndex = mode === "regex"
					? await regexSearch!.find(content)
					: matchesText!(content);
				if (contentIndex < 0) {
					if (filenameIndex >= 0) matches.push({ path: notePath, snippet: "Filename match" });
					continue;
				}
				if (options.pathsOnly) {
					matches.push({ path: notePath, snippet: "Path match" });
					continue;
				}

				const lines = content.split(/\r?\n/);
				const line = content.slice(0, contentIndex).split(/\r?\n/).length;
				const startLine = Math.max(0, line - 1 - contextLines);
				const endLine = Math.min(lines.length, line + contextLines);
				const snippet = lines.slice(startLine, endLine)
				.map((line) => line.length > MAX_SNIPPET_LINE_CHARS ? `${line.slice(0, MAX_SNIPPET_LINE_CHARS)}…` : line)
				.join("\n")
				.trimEnd() || normalizedQuery;
				matches.push({ path: notePath, line, snippet });
			}
			return matches;
		} finally {
			await regexSearch?.close();
		}
	}

	async resolveNoteFile(notePath: string): Promise<string> {
		const root = await this.getRoot();
		return this.resolveExistingNote(root, notePath);
	}

	async readNote(notePath: string): Promise<{ path: string; content: string; bytes: number }> {
		const root = await this.getRoot();
		const absolutePath = await this.resolveExistingNote(root, notePath);
		const noteStat = await stat(absolutePath);
		if (noteStat.size > MAX_NOTE_BYTES) {
			throw new Error(`Note is too large to read (maximum ${MAX_NOTE_BYTES} bytes): ${notePath}`);
		}
		return {
			path: this.toVaultPath(root, absolutePath),
			content: await readFile(absolutePath, "utf8"),
			bytes: noteStat.size,
		};
	}

	async writeNote(notePath: string, content: string, mode: NotesWriteMode): Promise<NotesWriteResult> {
		if (mode !== "create" && mode !== "overwrite" && mode !== "append") throw new Error(`Unsupported Notes write mode: ${mode}`);
		if (Buffer.byteLength(content, "utf8") > MAX_NOTE_BYTES) {
			throw new Error(`Note is too large to write (maximum ${MAX_NOTE_BYTES} bytes): ${notePath}`);
		}

		const root = await this.getRoot();
		const absolutePath = await this.resolveWritePath(root, notePath);
		return withFileMutationQueue(absolutePath, async () => {
			const existing = await lstat(absolutePath).catch((error: unknown) => {
				if (isMissing(error)) return undefined;
				throw error;
			});
			if (existing?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${notePath}`);
			if (existing && !existing.isFile()) throw new Error(`Note path is not a file: ${notePath}`);
			if (mode === "create" && existing) throw new Error(`Note already exists; use overwrite or append: ${notePath}`);
			if (mode === "append" && !existing) throw new Error(`Cannot append; note does not exist: ${notePath}`);

			if (existing && existing.size > MAX_NOTE_BYTES) throw new Error(`Note is too large to update (maximum ${MAX_NOTE_BYTES} bytes): ${notePath}`);
			const existingContent = mode === "append" && existing ? await readFile(absolutePath, "utf8") : undefined;
			const prepared = mode === "append" && existingContent !== undefined
				? ensureFrontmatter(existingContent, notePath).content + (existingContent.endsWith("\n") ? "" : "\n") + content
				: ensureFrontmatter(content, notePath).content;
			if (Buffer.byteLength(prepared, "utf8") > MAX_NOTE_BYTES) {
				throw new Error(`Note would be too large to write (maximum ${MAX_NOTE_BYTES} bytes): ${notePath}`);
			}
			await writeFile(absolutePath, prepared, { encoding: "utf8", flag: "w", mode: 0o600 });
			const finalStat = await stat(absolutePath);
			return { path: this.toVaultPath(root, absolutePath), mode, bytes: finalStat.size };
		});
	}

	async transferNote(sourcePath: string, destinationPath: string, action: NotesTransferAction): Promise<NotesTransferResult> {
		if (action !== "copy" && action !== "move") throw new Error(`Unsupported Notes transfer action: ${action}`);

		const root = await this.getRoot();
		const source = await this.resolveExistingNote(root, sourcePath);
		let destination = await this.resolveWritePath(root, destinationPath, false);
		if (source === destination) throw new Error("Source and destination must be different notes.");

		return this.withMutationLocks([source, destination], async () => {
			const sourceEntry = await lstat(source);
			if (sourceEntry.isSymbolicLink()) throw new Error(`Refusing to transfer through a symlink: ${sourcePath}`);
			if (!sourceEntry.isFile()) throw new Error(`Notes source is not a file: ${sourcePath}`);
			if (sourceEntry.size > MAX_NOTE_BYTES) {
				throw new Error(`Note is too large to transfer (maximum ${MAX_NOTE_BYTES} bytes): ${sourcePath}`);
			}

			const destinationEntry = await lstat(destination).catch((error: unknown) => {
				if (isMissing(error)) return undefined;
				throw error;
			});
			if (destinationEntry?.isSymbolicLink()) throw new Error(`Refusing to overwrite a symlink: ${destinationPath}`);
			if (destinationEntry) throw new Error(`Destination note already exists: ${destinationPath}`);

			destination = await this.resolveWritePath(root, destinationPath);
			const finalDestinationEntry = await lstat(destination).catch((error: unknown) => {
				if (isMissing(error)) return undefined;
				throw error;
			});
			if (finalDestinationEntry?.isSymbolicLink()) throw new Error(`Refusing to overwrite a symlink: ${destinationPath}`);
			if (finalDestinationEntry) throw new Error(`Destination note already exists: ${destinationPath}`);

			if (action === "copy") await copyFile(source, destination, constants.COPYFILE_EXCL);
			else await moveNoClobber(source, destination);

			const finalStat = await stat(destination);
			return {
				action,
				source: this.toVaultPath(root, source),
				destination: this.toVaultPath(root, destination),
				bytes: finalStat.size,
			};
		});
	}

	private withMutationLocks<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
		const uniquePaths = [...new Set(paths)].sort();
		const acquire = (index: number): Promise<T> => index >= uniquePaths.length
			? operation()
			: withFileMutationQueue(uniquePaths[index], () => acquire(index + 1));
		return acquire(0);
	}

	private async resolveDirectory(root: string, requestedPath: string): Promise<string> {
		const relativePath = normalizeRelativePath(requestedPath, true);
		const candidate = join(root, ...relativePath.split("/"));
		const resolved = await realpath(candidate).catch(() => {
			throw new Error(`Notes directory is unavailable: ${requestedPath}`);
		});
		this.assertInside(root, resolved);
		if (!(await stat(resolved)).isDirectory()) throw new Error(`Notes path is not a directory: ${requestedPath}`);
		return resolved;
	}

	private async resolveExistingNote(root: string, requestedPath: string): Promise<string> {
		const relativePath = normalizeRelativePath(requestedPath);
		const candidate = join(root, ...relativePath.split("/"));
		const linkStat = await lstat(candidate).catch((error: unknown) => {
			if (isMissing(error)) throw new Error(`Notes note not found: ${requestedPath}`);
			throw error;
		});
		if (linkStat.isSymbolicLink()) throw new Error(`Refusing to read through a symlink: ${requestedPath}`);
		const resolved = await realpath(candidate);
		this.assertInside(root, resolved);
		if (!(await stat(resolved)).isFile()) throw new Error(`Notes path is not a file: ${requestedPath}`);
		return resolved;
	}

	private async resolveWritePath(root: string, requestedPath: string, createParents = true): Promise<string> {
		const relativePath = normalizeRelativePath(requestedPath);
		const segments = relativePath.split("/");
		let current = root;
		for (let index = 0; index < segments.length - 1; index += 1) {
			const segment = segments[index];
			const next = join(current, segment);
			const entry = await lstat(next).catch((error: unknown) => {
				if (isMissing(error)) return undefined;
				throw error;
			});
			if (!entry && !createParents) {
				const target = join(current, ...segments.slice(index));
				this.assertInside(root, target);
				return target;
			}
			if (!entry) await mkdir(next, { recursive: true });
			const currentEntry = await lstat(next);
			if (currentEntry.isSymbolicLink()) {
				throw new Error(`Refusing to write through a symlinked directory: ${requestedPath}`);
			}
			if (!currentEntry.isDirectory()) {
				throw new Error(`Notes parent path is not a directory: ${segment}`);
			}
			current = await realpath(next);
			this.assertInside(root, current);
		}
		const target = join(current, segments.at(-1)!);
		this.assertInside(root, target);
		return target;
	}

	private async *walkNotePaths(start: string, root: string): AsyncGenerator<string> {
		const entries = await readdir(start, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			const child = join(start, entry.name);
			if (entry.isDirectory()) {
				yield* this.walkNotePaths(child, root);
			} else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".md")) {
				yield this.toVaultPath(root, child);
			}
		}
	}

	private async walkNotes(start: string, root: string, notes: NotesNote[], limit: number): Promise<void> {
		for await (const notePath of this.walkNotePaths(start, root)) {
			if (notes.length >= limit) return;
			const noteStat = await stat(join(root, ...notePath.split("/")));
			notes.push({ path: notePath, bytes: noteStat.size, modifiedAt: noteStat.mtime.toISOString() });
		}
	}

	private toVaultPath(root: string, absolutePath: string): string {
		return relative(root, absolutePath).split(sep).join("/");
	}

	private assertInside(root: string, candidate: string): void {
		const pathFromRoot = relative(root, candidate);
		if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) return;
		throw new Error("Notes path must stay inside the configured vault.");
	}
}

function normalizeRelativePath(value: string, allowDirectory = false): string {
	const normalized = value.trim().replace(/^@/, "").replaceAll("\\", "/");
	if (!normalized || normalized.includes("\0") || normalized.startsWith("/")) {
		throw new Error("Notes paths must be non-empty and relative to the vault.");
	}
	const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
	if (segments.some((segment) => segment === "..")) throw new Error("Notes paths cannot contain '..'.");
	if (segments.some((segment) => segment.startsWith("."))) throw new Error("Notes hidden paths are not available.");
	const result = segments.join("/");
	if (allowDirectory) return result || ".";
	if (!result || !result.toLocaleLowerCase().endsWith(".md")) {
		throw new Error("Notes note paths must point to a Markdown file ending in .md.");
	}
	return result;
}

function boundLimit(value: number): number {
	if (!Number.isFinite(value)) return 100;
	return Math.max(1, Math.min(500, Math.floor(value)));
}

function boundContextLines(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(5, Math.floor(value)));
}

function validateRegex(query: string, caseSensitive: boolean): void {
	if (query.length > MAX_REGEX_QUERY_CHARS) {
		throw new Error(`Notes search regular expressions are limited to ${MAX_REGEX_QUERY_CHARS} characters.`);
	}
	try {
		new RegExp(query, caseSensitive ? "" : "i");
	} catch (error) {
		throw new Error(`Invalid Notes search regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function createSearchMatcher(query: string, caseSensitive: boolean): (value: string) => number {
	const needle = caseSensitive ? query : query.toLocaleLowerCase();
	return (value) => (caseSensitive ? value : value.toLocaleLowerCase()).indexOf(needle);
}

class RegexSearchWorker {
	private readonly worker: Worker;
	private readonly ready: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: unknown) => void;
	private pending?: { resolve: (index: number) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
	private failure?: Error;
	private closed = false;

	constructor(query: string, caseSensitive: boolean) {
		this.worker = new Worker(new URL("./regex-worker.mjs", import.meta.url), {
			workerData: { query, flags: caseSensitive ? "" : "i" },
		});
		this.ready = new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.worker.on("message", (message: { ready?: boolean; index?: number; error?: string }) => {
			if (message.ready) {
				this.resolveReady();
				return;
			}
			if (!this.pending) return;
			const pending = this.pending;
			this.pending = undefined;
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(message.error));
			else if (typeof message.index === "number") pending.resolve(message.index);
			else pending.reject(new Error("Regex search worker returned an invalid result."));
		});
		this.worker.on("error", (error: Error) => {
			this.failure = error;
			this.rejectReady(error);
			const pending = this.pending;
			if (!pending) return;
			this.pending = undefined;
			clearTimeout(pending.timer);
			pending.reject(error);
		});
		this.worker.on("exit", (code) => {
			if (code === 0 || this.closed || this.failure) return;
			const error = new Error(`Regex search worker exited with code ${code}.`);
			this.failure = error;
			this.rejectReady(error);
			const pending = this.pending;
			if (!pending) return;
			this.pending = undefined;
			clearTimeout(pending.timer);
			pending.reject(error);
		});
	}

	async find(content: string): Promise<number> {
		await this.ready;
		if (this.closed) throw new Error("Regex search worker is closed.");
		if (this.failure) throw this.failure;
		return new Promise((resolveResult, reject) => {
			const timer = setTimeout(() => {
				this.closed = true;
				this.pending = undefined;
				reject(new Error(`Notes regex search exceeded ${REGEX_MATCH_TIMEOUT_MS}ms on one note.`));
				void this.worker.terminate().catch(() => undefined);
			}, REGEX_MATCH_TIMEOUT_MS);
			this.pending = { resolve: resolveResult, reject, timer };
			try {
				this.worker.postMessage({ content });
			} catch (error) {
				this.pending = undefined;
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const pending = this.pending;
		this.pending = undefined;
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Regex search worker closed."));
		}
		await this.worker.terminate().catch(() => undefined);
	}
}

async function moveNoClobber(source: string, destination: string): Promise<void> {
	try {
		await link(source, destination);
	} catch (error) {
		if (!isCrossDevice(error)) throw error;
		await copyFile(source, destination, constants.COPYFILE_EXCL);
	}
	try {
		await unlink(source);
	} catch (error) {
		await unlink(destination).catch(() => undefined);
		throw error;
	}
}

function createGlobMatcher(glob: string | undefined): (value: string) => boolean {
	if (!glob?.trim()) return () => true;
	const normalized = glob.trim().replaceAll("\\", "/");
	const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
	if (normalized.includes("\0") || normalized.startsWith("/") || segments.some((segment) => segment === ".." || segment.startsWith("."))) {
		throw new Error("Notes search globs must stay inside the configured vault and cannot target hidden paths.");
	}
	const patternInput = segments.join("/");
	if (!patternInput) return () => true;
	let pattern = "^";
	for (let index = 0; index < patternInput.length; index += 1) {
		const character = patternInput[index];
		if (character === "*" && patternInput[index + 1] === "*") {
			index += 1;
			if (patternInput[index + 1] === "/") {
				index += 1;
				pattern += "(?:.*/)?";
			} else {
				pattern += ".*";
			}
		} else if (character === "*") {
			pattern += "[^/]*";
		} else if (character === "?") {
			pattern += "[^/]";
		} else {
			pattern += character.replace(/[\\^$+{}()[\].|]/g, "\\$&");
		}
	}
	const expression = new RegExp(`${pattern}$`);
	return (value) => expression.test(value);
}

function isCrossDevice(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error.code === "EXDEV" || error.code === "EPERM"));
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
