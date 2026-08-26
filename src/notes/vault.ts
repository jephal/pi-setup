import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { ensureFrontmatter } from "./frontmatter.ts";
import { mkdir, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const MAX_NOTE_BYTES = 5 * 1024 * 1024;
export const MAX_SEARCH_FILES = 5_000;

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

export type NotesWriteMode = "create" | "overwrite" | "append";

export interface NotesWriteResult {
	path: string;
	mode: NotesWriteMode;
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

	async search(query: string, directory = ".", limit = 20): Promise<NotesSearchMatch[]> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) throw new Error("Search query cannot be empty.");

		const boundedLimit = Math.min(boundLimit(limit), 100);
		const root = await this.getRoot();
		const start = await this.resolveDirectory(root, directory);
		const matches: NotesSearchMatch[] = [];
		let filesVisited = 0;
		const needle = normalizedQuery.toLocaleLowerCase();

		for await (const notePath of this.walkNotePaths(start, root)) {
			if (matches.length >= boundedLimit) break;
			if (++filesVisited > MAX_SEARCH_FILES) break;

			const absolutePath = join(root, ...notePath.split("/"));
			const noteStat = await lstat(absolutePath);
			if (noteStat.size > MAX_NOTE_BYTES) continue;
			const content = await readFile(absolutePath, "utf8");
			const lowerContent = content.toLocaleLowerCase();
			const lowerPath = notePath.toLocaleLowerCase();
			const pathMatch = lowerPath.includes(needle);
			const index = lowerContent.indexOf(needle);
			if (!pathMatch && index < 0) continue;

			if (index < 0) {
				matches.push({ path: notePath, snippet: "Filename match" });
				continue;
			}

			const line = content.slice(0, index).split("\n").length;
			const lineStart = content.lastIndexOf("\n", index - 1) + 1;
			const lineEnd = content.indexOf("\n", index);
			const sourceLine = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd).trim();
			matches.push({ path: notePath, line, snippet: sourceLine || normalizedQuery });
		}

		return matches;
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

	private async resolveWritePath(root: string, requestedPath: string): Promise<string> {
		const relativePath = normalizeRelativePath(requestedPath);
		const segments = relativePath.split("/");
		let current = root;
		for (const segment of segments.slice(0, -1)) {
			const next = join(current, segment);
			const entry = await lstat(next).catch((error: unknown) => {
				if (isMissing(error)) return undefined;
				throw error;
			});
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

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
