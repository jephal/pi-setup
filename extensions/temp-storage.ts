import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PRIVATE_TEMP_DIR_ENV = "PI_SETUP_TEMP_DIR";
export const DISABLE_PRIVATE_TEMP_ENV = "PI_SETUP_DISABLE_PRIVATE_TEMP";
const KNOWN_TEMP_PREFIXES = ["pi-bash-", "pi-output-", "pi-fovea-", "pi-subagent-", "pi-mcp-forward-", "pi-clipboard-", "pi-wsl-clip-"] as const;
const REPORT_PATHS = [".pi/agent/sessions", ".cache/pi-fovea"] as const;

type StorageMeasure = { bytes: number; files: number; oldestMtimeMs?: number; newestMtimeMs?: number };
type StorageEntry = StorageMeasure & { path: string; kind: "file" | "directory" };

export function isKnownTempArtifact(name: string): boolean {
	return KNOWN_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function mergeMeasure(left: StorageMeasure, right: StorageMeasure): StorageMeasure {
	return {
		bytes: left.bytes + right.bytes,
		files: left.files + right.files,
		oldestMtimeMs: Math.min(left.oldestMtimeMs ?? Number.POSITIVE_INFINITY, right.oldestMtimeMs ?? Number.POSITIVE_INFINITY),
		newestMtimeMs: Math.max(left.newestMtimeMs ?? 0, right.newestMtimeMs ?? 0),
	};
}

async function measurePath(path: string): Promise<StorageMeasure> {
	let info;
	try { info = await lstat(path); } catch { return { bytes: 0, files: 0 }; }
	if (info.isSymbolicLink()) return { bytes: 0, files: 0 };
	if (info.isFile()) return { bytes: info.size, files: 1, oldestMtimeMs: info.mtimeMs, newestMtimeMs: info.mtimeMs };
	if (!info.isDirectory()) return { bytes: 0, files: 0 };
	let total: StorageMeasure = { bytes: 0, files: 0 };
	try {
		for (const child of await readdir(path)) total = mergeMeasure(total, await measurePath(join(path, child)));
	} catch { /* read-only diagnostics are best effort */ }
	return total;
}

async function scanKnownDirectory(root: string): Promise<StorageEntry[]> {
	let names: string[];
	try { names = await readdir(root); } catch { return []; }
	const entries: StorageEntry[] = [];
	for (const name of names.sort()) {
		if (!isKnownTempArtifact(name)) continue;
		const path = join(root, name);
		let info;
		try { info = await lstat(path); } catch { continue; }
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
		entries.push({ path, kind: info.isDirectory() ? "directory" : "file", ...(await measurePath(path)) });
	}
	return entries;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function summarize(label: string, entries: StorageEntry[]): string {
	const total = entries.reduce<StorageMeasure>((sum, entry) => mergeMeasure(sum, entry), { bytes: 0, files: 0 });
	const oldest = entries.map((entry) => entry.oldestMtimeMs).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
	const newest = entries.map((entry) => entry.newestMtimeMs).filter((value): value is number => value !== undefined).sort((a, b) => b - a)[0];
	return `${label}: ${formatBytes(total.bytes)}, ${total.files} files${oldest ? `, oldest ${new Date(oldest).toISOString()}` : ""}${newest ? `, newest ${new Date(newest).toISOString()}` : ""}`;
}

const TempStorageReportParams = Type.Object({
	includeSharedTmp: Type.Optional(Type.Boolean({ description: "Include known Pi artifact prefixes in the shared system temp directory" })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export function resolvePrivateTempDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[PRIVATE_TEMP_DIR_ENV];
	if (configured) {
		if (!isAbsolute(configured)) throw new Error(`${PRIVATE_TEMP_DIR_ENV} must be an absolute path.`);
		return resolve(configured);
	}
	const runtime = env.XDG_RUNTIME_DIR;
	if (runtime && isAbsolute(runtime)) return join(resolve(runtime), "pi-setup");
	const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
	return join(home, ".cache", "pi-setup", "tmp");
}

/**
 * Direct future Node temp output to a private, user-owned directory.
 * This is intentionally non-destructive: it creates or hardens only the
 * configured directory and never removes existing files.
 */
export function configurePrivateTempDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env[DISABLE_PRIVATE_TEMP_ENV] === "1") return undefined;
	const directory = resolvePrivateTempDirectory(env);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Private Pi temp path is not a real directory: ${directory}`);
	const uid = currentUid();
	if (uid !== undefined && info.uid !== uid) throw new Error(`Private Pi temp path is not owned by the current user: ${directory}`);
	chmodSync(directory, 0o700);
	env.TMPDIR = directory;
	env.TMP = directory;
	env.TEMP = directory;
	return directory;
}

export default function tempStorageExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_temp_storage_report",
		label: "Pi Temp Storage Report",
		description: "Read-only inventory of known Pi temp artifacts, private temp storage, sessions, and Fovea cache. This never deletes or changes files.",
		parameters: TempStorageReportParams,
		async execute(_toolCallId, params) {
			const privateDir = resolvePrivateTempDirectory();
			const privateEntries = await scanKnownDirectory(privateDir);
			const lines = [
				"Pi temp storage report (read-only; no files were changed)",
				summarize(`Private temp ${privateDir}`, privateEntries),
			];
			const details: Record<string, unknown> = { privateDir, privateEntries };
			if (params.includeSharedTmp !== false) {
				const sharedEntries = await scanKnownDirectory(tmpdir());
				lines.push(summarize(`Known artifacts under ${tmpdir()}`, sharedEntries));
				details.sharedEntries = sharedEntries;
			}
			for (const relative of REPORT_PATHS) {
				const path = join(homedir(), relative);
				const measure = await measurePath(path);
				lines.push(`${path}: ${formatBytes(measure.bytes)}, ${measure.files} files`);
				details[relative] = measure;
			}
			lines.push("No cleanup was performed. Review the report before approving any deletion policy.");
			return { content: [{ type: "text", text: lines.join("\n") }], details };
		},
	});
	pi.on("session_start", (_event, ctx) => {
		try {
			configurePrivateTempDirectory();
		} catch (error) {
			ctx.ui.notify(`Could not configure a private Pi temp directory: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});
}
