import { createConnection, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SUPERVISOR_SOCKET_ENV = "PI_SUBAGENT_SUPERVISOR_SOCKET";
export const SUPERVISOR_TOKEN_ENV = "PI_SUBAGENT_SUPERVISOR_TOKEN";
export const SUPERVISOR_TASK_ENV = "PI_SUBAGENT_SUPERVISOR_TASK";
const MAX_FRAME_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type ReportKind = "need_decision" | "progress_update";

export interface SupervisorReport {
	taskId: string;
	message: string;
	kind: ReportKind;
}

export interface SupervisorBridge {
	env: Record<string, string>;
	close(): Promise<void>;
}

export function isSupervisorChild(): boolean {
	return Boolean(process.env[SUPERVISOR_SOCKET_ENV] && process.env[SUPERVISOR_TOKEN_ENV] && process.env[SUPERVISOR_TASK_ENV]);
}

export async function createSupervisorBridge(
	taskId: string,
	onReport: (report: SupervisorReport) => void,
): Promise<SupervisorBridge> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-supervisor-"));
	try {
		await chmod(dir, 0o700);
	} catch (error) {
		await rmdir(dir).catch(() => undefined);
		throw error;
	}
	const socketPath = join(dir, "supervisor.sock");
	const token = randomUUID();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		handleConnection(socket, token, taskId, onReport);
	});

	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
	} catch (error) {
		await unlink(socketPath).catch(() => undefined);
		await rmdir(dir).catch(() => undefined);
		throw error;
	}

	return {
		env: {
			[SUPERVISOR_SOCKET_ENV]: socketPath,
			[SUPERVISOR_TOKEN_ENV]: token,
			[SUPERVISOR_TASK_ENV]: taskId,
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			await unlink(socketPath).catch(() => undefined);
			await rmdir(dir).catch(() => undefined);
		},
	};
}

function handleConnection(socket: Socket, token: string, taskId: string, onReport: (report: SupervisorReport) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("error", () => socket.destroy());
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
			socket.destroy();
			return;
		}
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			void handleFrame(socket, line, token, taskId, onReport);
		}
	});
}

async function handleFrame(socket: Socket, line: string, token: string, taskId: string, onReport: (report: SupervisorReport) => void): Promise<void> {
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		const id = typeof value.id === "string" ? value.id : "unknown";
		if (value.token !== token || value.taskId !== taskId || typeof value.message !== "string") {
			writeFrame(socket, { id, ok: false, error: "Supervisor authorization failed." });
			return;
		}
		const message = value.message.trim();
		if (!message || Buffer.byteLength(message, "utf8") > MAX_FRAME_BYTES / 2) {
			writeFrame(socket, { id, ok: false, error: "Supervisor report is empty or too large." });
			return;
		}
		const kind = value.kind === "need_decision" ? "need_decision" : value.kind === "progress_update" ? "progress_update" : undefined;
		if (!kind) {
			writeFrame(socket, { id, ok: false, error: "Supervisor report kind is invalid." });
			return;
		}
		onReport({ taskId, message, kind });
		writeFrame(socket, { id, ok: true });
	} catch {
		writeFrame(socket, { id: "unknown", ok: false, error: "Malformed supervisor report." });
	}
}

function writeFrame(socket: Socket, value: Record<string, unknown>): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

export async function sendSupervisorReport(
	message: string,
	kind: ReportKind,
	signal?: AbortSignal,
): Promise<void> {
	const socketPath = process.env[SUPERVISOR_SOCKET_ENV];
	const token = process.env[SUPERVISOR_TOKEN_ENV];
	const taskId = process.env[SUPERVISOR_TASK_ENV];
	if (!socketPath || !token || !taskId) throw new Error("Supervisor reporting is unavailable in this process.");
	if (signal?.aborted) throw new Error("Supervisor report was aborted.");
	if (!message.trim()) throw new Error("Supervisor report cannot be empty.");
	if (Buffer.byteLength(message, "utf8") > MAX_FRAME_BYTES / 2) throw new Error(`Supervisor report exceeds ${MAX_FRAME_BYTES / 2} bytes.`);

	const id = randomUUID();
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			socket.destroy();
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error("Supervisor report timed out."))), REQUEST_TIMEOUT_MS);
		const abort = () => finish(() => reject(new Error("Supervisor report was aborted.")));
		signal?.addEventListener("abort", abort, { once: true });
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify({ id, token, taskId, message, kind })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline)) as { id?: string; ok?: boolean; error?: string };
				if (response.id !== id) throw new Error("Supervisor response ID mismatch.");
				if (!response.ok) throw new Error(response.error || "Supervisor rejected the report.");
				finish(resolve);
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
		socket.on("error", (error) => finish(() => reject(new Error(`Supervisor connection failed: ${error.message}`))));
		socket.once("close", () => {
			if (!settled) finish(() => reject(new Error("Supervisor connection closed.")));
		});
	});
}
