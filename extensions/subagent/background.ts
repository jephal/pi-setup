import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { SupervisorBridge, SupervisorReport } from "./supervisor-bridge.ts";

const MAX_OUTPUT_BYTES = 12 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 1_000;
const FORCE_KILL_TIMEOUT_MS = 1_000;
export const MAX_BACKGROUND_TASKS = 8;
export const MAX_BACKGROUND_MESSAGE_BYTES = 64 * 1024;

export type BackgroundTaskStatus = "starting" | "running" | "completed" | "failed" | "cancelled";
export type BackgroundDelivery = "steer" | "followUp";

export interface BackgroundTaskSnapshot {
	id: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	cwd: string;
	status: BackgroundTaskStatus;
	output: string;
	stderr: string;
	reports: SupervisorReport[];
	startedAt: number;
	updatedAt: number;
	model?: string;
	errorMessage?: string;
}

export interface BackgroundTaskSpec {
	id?: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	cwd: string;
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	model?: string;
	bridge: SupervisorBridge;
	onReport: (snapshot: BackgroundTaskSnapshot, report: SupervisorReport) => void;
	onSettled: (snapshot: BackgroundTaskSnapshot) => void;
}

interface PendingRequest {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function appendBounded(current: string, next: string, maxBytes: number): string {
	const combined = current + next;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	const bytes = Buffer.from(combined, "utf8");
	return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8");
}

function messageText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("Background task startup was aborted."));
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			signal.removeEventListener("abort", abort);
			reject(new Error("Background task startup was aborted."));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error) => { signal.removeEventListener("abort", abort); reject(error); },
		);
	});
}

function getPiInvocation(command: string, args: string[]): { command: string; args: string[] } {
	if (command !== "pi") return { command, args };
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command, args };
}

class RpcBackgroundChild {
	readonly snapshot: BackgroundTaskSnapshot;
	private readonly process: ChildProcessWithoutNullStreams;
	private buffer = "";
	private settled = false;
	private cancelled = false;
	private requestCounter = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly onReport: BackgroundTaskSpec["onReport"];
	private readonly onSettled: BackgroundTaskSpec["onSettled"];
	private readonly bridge: SupervisorBridge;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private settlementGeneration = 0;
	private turnHasMessage = false;
	private closed = false;

	private constructor(spec: BackgroundTaskSpec, process: ChildProcessWithoutNullStreams) {
		this.snapshot = {
			id: spec.id ?? randomUUID().slice(0, 8),
			agent: spec.agent,
			agentSource: spec.agentSource,
			task: spec.task,
			cwd: spec.cwd,
			status: "starting",
			output: "",
			stderr: "",
			reports: [],
			startedAt: Date.now(),
			updatedAt: Date.now(),
			model: spec.model,
		};
		this.process = process;
		this.onReport = spec.onReport;
		this.onSettled = spec.onSettled;
		this.bridge = spec.bridge;
		process.stdout.on("data", (data) => this.consume(data.toString()));
		process.stderr.on("data", (data) => {
			this.snapshot.stderr = appendBounded(this.snapshot.stderr, data.toString(), MAX_STDERR_BYTES);
			this.snapshot.updatedAt = Date.now();
		});
		process.once("error", (error) => this.fail(error.message));
		process.once("close", (code, signal) => {
			if (this.cancelled || this.snapshot.status === "cancelled") return;
			if (!this.settled && code !== 0) this.fail(`Background child exited with ${signal || code || "an unknown error"}.`);
		});
	}

	static async start(spec: BackgroundTaskSpec): Promise<RpcBackgroundChild> {
		const invocation = getPiInvocation(spec.command, spec.args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: spec.cwd,
			env: spec.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const instance = new RpcBackgroundChild(spec, child);
		// Mark the child live before its first RPC. The child may emit
		// agent_settled in the same stdout turn as the prompt acknowledgement.
		instance.snapshot.status = "running";
		instance.snapshot.updatedAt = Date.now();
		try {
			await waitForAbort(instance.sendCommand({ type: "prompt", message: spec.task }), spec.signal);
			if (spec.signal?.aborted) throw new Error("Background task startup was aborted.");
		} catch (error) {
			instance.cancelled = true;
			instance.closed = true;
			instance.clearSettleTimer();
			instance.clearPending("Background task startup was aborted.");
			await instance.terminate();
			await spec.bridge.close().catch(() => undefined);
			throw error;
		}
		if (instance.snapshot.status === "starting") instance.snapshot.status = "running";
		instance.snapshot.updatedAt = Date.now();
		return instance;
	}

	async send(message: string, delivery: BackgroundDelivery): Promise<void> {
		if (this.closed || this.snapshot.status === "failed" || this.snapshot.status === "cancelled") throw new Error(`Background task ${this.snapshot.id} is ${this.snapshot.status}.`);
		if (!message.trim()) throw new Error("Background subagent message cannot be empty.");
		if (Buffer.byteLength(message, "utf8") > MAX_BACKGROUND_MESSAGE_BYTES) throw new Error(`Background subagent message exceeds ${MAX_BACKGROUND_MESSAGE_BYTES} bytes.`);
		// A follow-up revives a completed child. It must invalidate the deferred
		// completion callback from the previous run before changing its state.
		this.settlementGeneration++;
		this.clearSettleTimer();
		this.settled = false;
		this.turnHasMessage = false;
		// Set running before writing the command. The child can answer and emit
		// its complete event synchronously with that write; setting this after
		// await would overwrite the completed state from that event.
		this.snapshot.status = "running";
		this.snapshot.updatedAt = Date.now();
		await this.sendCommand({ type: delivery === "steer" ? "steer" : "follow_up", message });
	}

	async cancel(): Promise<void> {
		if (this.snapshot.status === "cancelled" || this.snapshot.status === "failed") {
			this.clearSettleTimer();
			return;
		}
		if (this.snapshot.status === "completed") {
			this.clearSettleTimer();
			return;
		}
		this.cancelled = true;
		this.closed = true;
		this.clearSettleTimer();
		this.snapshot.status = "cancelled";
		this.snapshot.updatedAt = Date.now();
		try {
			await this.sendCommand({ type: "abort" }, CANCEL_TIMEOUT_MS);
		} catch {
			// The process may already have exited.
		}
		this.clearPending("Background task was cancelled.");
		await this.terminate();
		await this.bridge.close();
	}

	async close(): Promise<void> {
		this.cancelled = true;
		this.closed = true;
		this.clearSettleTimer();
		this.clearPending("Background task supervisor is shutting down.");
		await this.terminate();
		await this.bridge.close();
	}

	private consume(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";
		for (const line of lines) this.consumeLine(line);
	}

	private consumeLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "response" && typeof event.id === "string") {
			const request = this.pending.get(event.id);
			if (!request) return;
			this.pending.delete(event.id);
			clearTimeout(request.timer);
			if (event.success === false) request.reject(new Error(event.error || `RPC command ${event.command || "unknown"} failed.`));
			else request.resolve();
			return;
		}
		if (event.type === "agent_start") {
			// A follow-up can start before the previous turn's deferred completion
			// callback runs. Invalidate both the callback and the old turn's state.
			this.settlementGeneration++;
			this.clearSettleTimer();
			this.settled = false;
			this.turnHasMessage = false;
			this.snapshot.status = "running";
			this.snapshot.updatedAt = Date.now();
			return;
		}
		if (event.type === "message_end" && event.message) {
			this.turnHasMessage = true;
			const message = event.message as Message;
			const text = messageText(message);
			if (text) this.snapshot.output = appendBounded(this.snapshot.output, text, MAX_OUTPUT_BYTES);
			if (message.role === "assistant") {
				this.snapshot.model = message.model || this.snapshot.model;
				if (message.errorMessage) this.snapshot.errorMessage = message.errorMessage;
			}
			this.snapshot.updatedAt = Date.now();
			return;
		}
		if (event.type === "agent_settled") {
			this.settle(this.settlementGeneration);
		}
	}

	private settle(generation: number): void {
		// agent_settled has no turn identifier. Require activity from the current
		// turn so a late prior settlement cannot complete a newly started turn.
		if (this.cancelled || this.closed || this.settled || generation !== this.settlementGeneration || !this.turnHasMessage) return;
		this.settled = true;
		this.snapshot.status = this.snapshot.errorMessage ? "failed" : "completed";
		this.snapshot.updatedAt = Date.now();
		this.clearSettleTimer();
		this.settleTimer = setTimeout(() => {
			this.settleTimer = undefined;
			if (generation === this.settlementGeneration && !this.closed && !this.cancelled) this.onSettled(this.snapshot);
		}, 0);
	}

	private clearSettleTimer(): void {
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
	}

	private fail(message: string): void {
		if (this.cancelled || this.closed || this.settled) return;
		this.settled = true;
		this.snapshot.status = "failed";
		this.snapshot.errorMessage = message;
		this.snapshot.updatedAt = Date.now();
		this.clearSettleTimer();
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error(message));
		}
		this.pending.clear();
		void this.bridge.close();
		this.onSettled(this.snapshot);
	}

	private async terminate(): Promise<void> {
		if (this.process.exitCode !== null || this.process.signalCode !== null) return;
		this.process.kill("SIGTERM");
		if (await this.waitForExit(CANCEL_TIMEOUT_MS)) return;
		if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
		await this.waitForExit(FORCE_KILL_TIMEOUT_MS);
	}

	private waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.process.exitCode !== null || this.process.signalCode !== null) return Promise.resolve(true);
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (exited: boolean): void => {
				if (timer) clearTimeout(timer);
				this.process.removeListener("close", onClose);
				resolve(exited);
			};
			const onClose = (): void => done(true);
			this.process.once("close", onClose);
			timer = setTimeout(() => done(false), timeoutMs);
		});
	}

	private clearPending(message: string): void {
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(new Error(message));
			this.pending.delete(id);
		}
	}

	private async sendCommand(command: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
		if (!this.process.stdin.writable) throw new Error(`Background task ${this.snapshot.id} is not accepting commands.`);
		const id = `req-${++this.requestCounter}`;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC command ${String(command.type)} timed out.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (error) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}

	addReport(report: SupervisorReport): void {
		this.snapshot.reports.push(report);
		if (this.snapshot.reports.length > 20) this.snapshot.reports.shift();
		this.snapshot.updatedAt = Date.now();
		this.onReport(this.snapshot, report);
	}
}

export class BackgroundTaskManager {
	private readonly tasks = new Map<string, RpcBackgroundChild>();
	private readonly pendingStarts = new Map<Promise<RpcBackgroundChild>, AbortController>();
	private lifecycleEpoch = 0;
	private shuttingDown = false;
	private shutdownPromise: Promise<void> | undefined;

	async start(spec: BackgroundTaskSpec): Promise<BackgroundTaskSnapshot> {
		if (this.shuttingDown) throw new Error("Background task manager is shutting down.");
		if (this.tasks.size + this.pendingStarts.size >= MAX_BACKGROUND_TASKS) throw new Error(`Maximum background subagent limit reached (${MAX_BACKGROUND_TASKS}).`);
		const epoch = this.lifecycleEpoch;
		const startController = new AbortController();
		const startSignal = spec.signal
			? AbortSignal.any([spec.signal, startController.signal])
			: startController.signal;
		const pending = RpcBackgroundChild.start({ ...spec, signal: startSignal });
		this.pendingStarts.set(pending, startController);
		try {
			const child = await pending;
			if (this.shuttingDown || epoch !== this.lifecycleEpoch) {
				await child.close().catch(() => undefined);
				throw new Error("Background task startup was superseded by shutdown.");
			}
			const id = child.snapshot.id;
			this.tasks.set(id, child);
			return child.snapshot;
		} finally {
			this.pendingStarts.delete(pending);
		}
	}

	get(id: string): BackgroundTaskSnapshot | undefined {
		return this.tasks.get(id)?.snapshot;
	}

	list(): BackgroundTaskSnapshot[] {
		return [...this.tasks.values()].map((task) => task.snapshot);
	}

	async send(id: string, message: string, delivery: BackgroundDelivery): Promise<BackgroundTaskSnapshot> {
		const child = this.tasks.get(id);
		if (!child) throw new Error(`Background task ${id} was not found.`);
		await child.send(message, delivery);
		// Preserve the command API's acknowledgement semantics even if the child
		// completed the follow-up in the same stdout turn. The manager's live
		// snapshot (returned by get/list) retains the authoritative status.
		return { ...child.snapshot, status: "running" };
	}

	async cancel(id: string): Promise<BackgroundTaskSnapshot> {
		const child = this.tasks.get(id);
		if (!child) throw new Error(`Background task ${id} was not found.`);
		await child.cancel();
		return child.snapshot;
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shuttingDown = true;
		this.lifecycleEpoch++;
		this.shutdownPromise = (async () => {
			for (const controller of this.pendingStarts.values()) controller.abort();
			await Promise.all([...this.pendingStarts.keys()].map((pending) => pending.catch(() => undefined)));
			await Promise.all([...this.tasks.values()].map((task) => task.close().catch(() => undefined)));
			this.tasks.clear();
		})().finally(() => {
			this.shuttingDown = false;
			this.shutdownPromise = undefined;
		});
		return this.shutdownPromise;
	}

	addReport(id: string, report: SupervisorReport): void {
		this.tasks.get(id)?.addReport(report);
	}
}
