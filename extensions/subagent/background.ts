import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { SupervisorBridge, SupervisorReport } from "./supervisor-bridge.ts";

const MAX_OUTPUT_BYTES = 12 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const MAX_CONTINUATION_OUTPUT_BYTES = 3 * 1024;
const MAX_CONTINUATION_STDERR_BYTES = 512;
export const MAX_REPLAY_BYTES = 64 * 1024;
export const MAX_TERMINAL_TASKS = 64;
export const MAX_BACKGROUND_BATCHES = 32;
export const TERMINAL_TASK_TTL_MS = 10 * 60 * 1000;
export const BACKGROUND_BATCH_TTL_MS = 10 * 60 * 1000;
const REPLAY_PREAMBLE = "Continue the completed background task in a fresh child. The previous child context is gone.";
const COMMAND_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 1_000;
const FORCE_KILL_TIMEOUT_MS = 1_000;
export const MAX_BACKGROUND_TASKS = 8;
export const MAX_BACKGROUND_MESSAGE_BYTES = 64 * 1024;

export type BackgroundTaskStatus = "starting" | "running" | "completed" | "failed" | "cancelled";
export type BackgroundDelivery = "steer" | "followUp";

export interface BackgroundTaskSnapshot {
	id: string;
	batchId?: string;
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
	/** Monotonically increases when a completed task is restarted under the same public ID. */
	generation?: number;
	/** True after the detailed terminal result has been consumed. */
	resultConsumed?: boolean;
}

export type BackgroundBatchStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundBatchSnapshot {
	id: string;
	taskIds: string[];
	status: BackgroundBatchStatus;
	total: number;
	completed: number;
	failed: number;
	cancelled: number;
	startedAt: number;
	updatedAt: number;
}

export interface BackgroundTaskSpec {
	id?: string;
	batchId?: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	cwd: string;
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	model?: string;
	/** Internal generation number; completed fresh follow-ups increment it. */
	generation?: number;
	bridge: SupervisorBridge;
	onReport: (snapshot: BackgroundTaskSnapshot, report: SupervisorReport) => void;
	onSettled: (snapshot: BackgroundTaskSnapshot) => void;
	/** Creates a new RPC child for a completed follow-up. The public task ID is preserved. */
	createFollowUp?: (replayPrompt: string) => Promise<BackgroundTaskSpec>;
	/** Removes one-shot startup artifacts after the child has accepted its initial prompt. */
	onStarted?: () => Promise<void>;
	/** Releases all startup artifacts when startup or a fresh follow-up fails. */
	onStartupFailure?: () => Promise<void>;
}

export interface BackgroundTaskResult {
	snapshot: BackgroundTaskSnapshot;
	/** True when the detailed result had already been consumed before this call. */
	consumed: boolean;
}

export interface BackgroundBatchResult {
	batch: BackgroundBatchSnapshot;
	tasks: BackgroundTaskSnapshot[];
	/** True when every task result had already been consumed before this call. */
	consumed: boolean;
}

interface PendingRequest {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ChildTerminalEvent {
	child: RpcBackgroundChild;
	snapshot: BackgroundTaskSnapshot;
	executionToken: number;
}

type ChildTerminalHandler = (event: ChildTerminalEvent) => void;

function appendBounded(current: string, next: string, maxBytes: number): string {
	const combined = current + next;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	const characters = Array.from(combined);
	let result = "";
	let bytes = 0;
	for (let index = characters.length - 1; index >= 0; index--) {
		const character = characters[index];
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result = character + result;
		bytes += characterBytes;
	}
	return result;
}

function headBounded(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function cloneTask(snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
	return { ...snapshot, reports: snapshot.reports.map((report) => ({ ...report })) };
}

function cloneBatch(snapshot: BackgroundBatchSnapshot): BackgroundBatchSnapshot {
	return { ...snapshot, taskIds: [...snapshot.taskIds] };
}

function continuationSnapshot(snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
	return {
		...cloneTask(snapshot),
		output: headBounded(snapshot.output, MAX_CONTINUATION_OUTPUT_BYTES),
		stderr: headBounded(snapshot.stderr, MAX_CONTINUATION_STDERR_BYTES),
		resultConsumed: true,
	};
}

export function buildFollowUpReplay(snapshot: BackgroundTaskSnapshot, message: string): string {
	// Keep the preamble and the new request even when the previous result is large.
	// Every bound is measured in UTF-8 bytes, not JavaScript string length.
	const suffix = "\n\nNew follow-up request:\n";
	const fixedBytes = Buffer.byteLength(`${REPLAY_PREAMBLE}${suffix}`, "utf8");
	const messageLimit = Math.max(0, Math.min(48 * 1024, MAX_REPLAY_BYTES - fixedBytes));
	const boundedMessage = headBounded(message, messageLimit);
	const priorLimit = Math.max(0, MAX_REPLAY_BYTES - fixedBytes - Buffer.byteLength(boundedMessage, "utf8"));
	const prior = [
		snapshot.task ? `Original task: ${headBounded(snapshot.task, Math.min(8 * 1024, priorLimit))}` : "Original task: (none)",
		snapshot.output ? `Bounded previous output:\n${headBounded(snapshot.output, Math.min(MAX_CONTINUATION_OUTPUT_BYTES, priorLimit))}` : "Bounded previous output: (none)",
		snapshot.stderr ? `Bounded previous diagnostics:\n${headBounded(snapshot.stderr, Math.min(MAX_CONTINUATION_STDERR_BYTES, priorLimit))}` : "",
	].filter(Boolean).join("\n\n");
	return `${REPLAY_PREAMBLE}\n\n${headBounded(prior, priorLimit)}${suffix}${boundedMessage}`;
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
	private readonly bridge: SupervisorBridge;
	private readonly onTerminal: ChildTerminalHandler;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private settlementGeneration = 0;
	private turnHasMessage = false;
	private closed = false;
	private closePromise: Promise<void> | undefined;

	private constructor(spec: BackgroundTaskSpec, process: ChildProcessWithoutNullStreams, onTerminal: ChildTerminalHandler) {
		const now = Date.now();
		this.snapshot = {
			id: spec.id ?? randomUUID().slice(0, 8),
			...(spec.batchId ? { batchId: spec.batchId } : {}),
			agent: spec.agent,
			agentSource: spec.agentSource,
			task: spec.task,
			cwd: spec.cwd,
			status: "starting",
			output: "",
			stderr: "",
			reports: [],
			startedAt: now,
			updatedAt: now,
			model: spec.model,
			generation: spec.generation ?? 0,
		};
		this.process = process;
		this.onReport = spec.onReport;
		this.bridge = spec.bridge;
		this.onTerminal = onTerminal;
		process.stdout.on("data", (data) => this.consume(data.toString()));
		process.stderr.on("data", (data) => {
			this.snapshot.stderr = appendBounded(this.snapshot.stderr, data.toString(), MAX_STDERR_BYTES);
			this.snapshot.updatedAt = Date.now();
		});
		process.once("error", (error) => this.fail(error.message));
		process.once("close", (code, signal) => {
			if (this.cancelled || this.closed) return;
			if (!this.settled) {
				this.fail(`Background child exited before agent_settled (${signal || code || "an unknown exit"}).`);
			}
		});
	}

	static async start(spec: BackgroundTaskSpec, onTerminal: ChildTerminalHandler): Promise<RpcBackgroundChild> {
		const invocation = getPiInvocation(spec.command, spec.args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: spec.cwd,
			env: spec.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const instance = new RpcBackgroundChild(spec, child, onTerminal);
		// Mark live before the first RPC. The child may emit all events in one turn.
		instance.snapshot.status = "running";
		instance.snapshot.updatedAt = Date.now();
		try {
			await waitForAbort(instance.sendCommand({ type: "prompt", message: spec.task }), spec.signal);
			if (spec.signal?.aborted) throw new Error("Background task startup was aborted.");
		} catch (error) {
			await instance.close();
			throw error;
		}
		instance.snapshot.updatedAt = Date.now();
		return instance;
	}

	async send(message: string, delivery: BackgroundDelivery): Promise<void> {
		if (this.closed || this.snapshot.status === "failed" || this.snapshot.status === "cancelled") throw new Error(`Background task ${this.snapshot.id} is ${this.snapshot.status}.`);
		if (!message.trim()) throw new Error("Background subagent message cannot be empty.");
		if (Buffer.byteLength(message, "utf8") > MAX_BACKGROUND_MESSAGE_BYTES) throw new Error(`Background subagent message exceeds ${MAX_BACKGROUND_MESSAGE_BYTES} bytes.`);
		this.settlementGeneration++;
		this.clearSettleTimer();
		this.settled = false;
		this.turnHasMessage = false;
		this.snapshot.status = "running";
		this.snapshot.updatedAt = Date.now();
		await this.sendCommand({ type: delivery === "steer" ? "steer" : "follow_up", message });
	}

	async cancel(): Promise<void> {
		if (this.snapshot.status === "cancelled" || this.snapshot.status === "failed" || this.snapshot.status === "completed") {
			await this.close();
			return;
		}
		this.cancelled = true;
		this.snapshot.status = "cancelled";
		this.snapshot.updatedAt = Date.now();
		try {
			await this.sendCommand({ type: "abort" }, CANCEL_TIMEOUT_MS);
		} catch {
			// The process may already have exited.
		}
		this.clearPending("Background task was cancelled.");
		await this.close();
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.cancelled = true;
		this.closed = true;
		this.clearSettleTimer();
		this.clearPending("Background task supervisor is shutting down.");
		this.closePromise = (async () => {
			await this.terminate();
			await this.bridge.close();
		})();
		return this.closePromise;
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
		try { event = JSON.parse(line); } catch { return; }
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
		if (event.type === "agent_settled") this.settle(this.settlementGeneration);
	}

	private settle(generation: number): void {
		if (this.cancelled || this.closed || this.settled || generation !== this.settlementGeneration || !this.turnHasMessage) return;
		this.settled = true;
		this.snapshot.status = this.snapshot.errorMessage ? "failed" : "completed";
		this.snapshot.updatedAt = Date.now();
		this.clearSettleTimer();
		const terminal = cloneTask(this.snapshot);
		this.settleTimer = setTimeout(() => {
			this.settleTimer = undefined;
			if (generation === this.settlementGeneration && !this.closed && !this.cancelled) {
				this.emitTerminal(generation, terminal);
			}
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
		// Notify asynchronously; the manager buffers this event until registration.
		const generation = this.settlementGeneration;
		const terminal = cloneTask(this.snapshot);
		setTimeout(() => {
			if (!this.closed && !this.cancelled) this.emitTerminal(generation, terminal);
		}, 0);
	}

	private emitTerminal(executionToken: number, snapshot: BackgroundTaskSnapshot): void {
		this.onTerminal({ child: this, snapshot: cloneTask(snapshot), executionToken });
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

	isTerminalEventCurrent(executionToken: number): boolean {
		return executionToken === this.settlementGeneration && this.settled;
	}

	addReport(report: SupervisorReport): void {
		this.snapshot.reports.push(report);
		if (this.snapshot.reports.length > 20) this.snapshot.reports.shift();
		this.snapshot.updatedAt = Date.now();
		this.onReport(this.snapshot, report);
	}
}

interface TerminalTaskRecord {
	snapshot: BackgroundTaskSnapshot;
	continuation: BackgroundTaskSnapshot;
	resultConsumed: boolean;
	createFollowUp?: BackgroundTaskSpec["createFollowUp"];
	lastAccessedAt: number;
}

interface BackgroundBatchRecord {
	snapshot: BackgroundBatchSnapshot;
	taskSnapshots: Map<string, BackgroundTaskSnapshot>;
	expectedTaskCount: number;
	notified: boolean;
	onSettled?: (snapshot: BackgroundBatchSnapshot) => void;
	lastAccessedAt: number;
}

interface StartReservation {
	controller: AbortController;
	id: string;
	registered: boolean;
	failed: boolean;
	events: ChildTerminalEvent[];
}

export class BackgroundTaskManager {
	private readonly tasks = new Map<string, RpcBackgroundChild>();
	private readonly terminalTasks = new Map<string, TerminalTaskRecord>();
	private readonly batches = new Map<string, BackgroundBatchRecord>();
	private readonly pendingStarts = new Map<Promise<RpcBackgroundChild>, StartReservation>();
	private readonly startingIds = new Set<string>();
	private readonly followUpLocks = new Map<string, Promise<BackgroundTaskSnapshot>>();
	private readonly terminalizedChildren = new WeakSet<RpcBackgroundChild>();
	private readonly childSpecs = new WeakMap<RpcBackgroundChild, BackgroundTaskSpec>();
	private readonly childLocks = new WeakMap<RpcBackgroundChild, Promise<void>>();
	private lifecycleEpoch = 0;
	private shuttingDown = false;
	private shutdownPromise: Promise<void> | undefined;

	private activeCount(): number {
		// A startup reservation transfers to tasks before it is removed from
		// pendingStarts, so it is never counted twice.
		const activeChildren = [...this.tasks.values()].filter((task) => task.snapshot.status === "starting" || task.snapshot.status === "running").length;
		return activeChildren + this.pendingStarts.size;
	}

	private pruneRetention(): void {
		const now = Date.now();
		for (const [id, record] of this.terminalTasks) if (now - record.lastAccessedAt >= TERMINAL_TASK_TTL_MS) this.terminalTasks.delete(id);
		while (this.terminalTasks.size > MAX_TERMINAL_TASKS) {
			const oldest = this.terminalTasks.keys().next().value as string | undefined;
			if (!oldest) break;
			this.terminalTasks.delete(oldest);
		}
		for (const [id, batch] of this.batches) if (!(batch.snapshot.status === "starting" || batch.snapshot.status === "running") && now - batch.lastAccessedAt >= BACKGROUND_BATCH_TTL_MS) this.evictBatch(id);
		while (this.batches.size > MAX_BACKGROUND_BATCHES) {
			const oldest = this.batches.keys().next().value as string | undefined;
			if (!oldest) break;
			this.evictBatch(oldest);
		}
	}

	private evictBatch(id: string): void {
		const batch = this.batches.get(id);
		if (!batch) return;
		batch.onSettled = undefined;
		batch.taskSnapshots.clear();
		this.batches.delete(id);
	}

	private touchTerminal(id: string): TerminalTaskRecord | undefined {
		const record = this.terminalTasks.get(id);
		if (record) {
			record.lastAccessedAt = Date.now();
			this.terminalTasks.delete(id);
			this.terminalTasks.set(id, record);
		}
		return record;
	}

	private putTerminal(id: string, record: TerminalTaskRecord): void {
		record.lastAccessedAt = Date.now();
		this.terminalTasks.delete(id);
		this.terminalTasks.set(id, record);
		this.pruneRetention();
	}

	private ensureCapacity(additional = 1): void {
		if (this.activeCount() + additional > MAX_BACKGROUND_TASKS) throw new Error(`Maximum background subagent limit reached (${MAX_BACKGROUND_TASKS}).`);
	}

	async start(spec: BackgroundTaskSpec): Promise<BackgroundTaskSnapshot> {
		this.pruneRetention();
		if (this.shuttingDown) throw new Error("Background task manager is shutting down.");
		this.ensureCapacity();
		const id = spec.id ?? randomUUID().slice(0, 8);
		if (this.tasks.has(id) || this.startingIds.has(id) || this.terminalTasks.has(id)) throw new Error(`Background task ID ${id} is already in use.`);
		this.startingIds.add(id);
		const epoch = this.lifecycleEpoch;
		const startController = new AbortController();
		const startSignal = spec.signal ? AbortSignal.any([spec.signal, startController.signal]) : startController.signal;
		let reservation: StartReservation | undefined;
		const earlyEvents: ChildTerminalEvent[] = [];
		const onTerminal = (event: ChildTerminalEvent): void => {
			if (!reservation) earlyEvents.push(event);
			else if (!reservation.registered) reservation.events.push(event);
			else if (!reservation.failed) void this.withChildLock(event.child, () => this.terminalize(event, spec)).catch(() => undefined);
		};
		let child: RpcBackgroundChild | undefined;
		const pending = RpcBackgroundChild.start({ ...spec, id, signal: startSignal }, onTerminal);
		reservation = { controller: startController, id, registered: false, failed: false, events: earlyEvents };
		this.pendingStarts.set(pending, reservation);
		try {
			child = await pending;
			if (this.shuttingDown || epoch !== this.lifecycleEpoch) {
				await child.close().catch(() => undefined);
				throw new Error("Background task startup was superseded by shutdown.");
			}
			this.childSpecs.set(child, spec);
			this.tasks.set(id, child);
			// Transfer the capacity reservation before any await. The child is now
			// counted by tasks, never by both maps.
			this.pendingStarts.delete(pending);
			this.startingIds.delete(id);
			reservation.registered = true;
			this.recordBatchTask(child.snapshot);
			for (const event of reservation.events) await this.withChildLock(event.child, () => this.terminalize(event, spec));
			await spec.onStarted?.();
			return cloneTask(child.snapshot);
		} catch (error) {
			reservation.failed = true;
			if (child) {
				await child.close().catch(() => undefined);
				this.tasks.delete(id);
			}
			this.startingIds.delete(id);
			try { await spec.onStartupFailure?.(); } catch { /* cleanup is best effort */ }
			throw error;
		} finally {
			this.pendingStarts.delete(pending);
		}
	}

	async startBatch(
		specs: BackgroundTaskSpec[],
		onSettled: (snapshot: BackgroundBatchSnapshot) => void,
	): Promise<{ batch: BackgroundBatchSnapshot; tasks: BackgroundTaskSnapshot[] }> {
		if (specs.length === 0) throw new Error("A background batch requires at least one task.");
		this.pruneRetention();
		this.ensureCapacity(specs.length);
		const id = randomUUID().slice(0, 8);
		const taskIds = specs.map((spec) => spec.id ?? randomUUID().slice(0, 8));
		if (new Set(taskIds).size !== taskIds.length) throw new Error("Background batch contains duplicate task IDs.");
		for (const taskId of taskIds) if (this.tasks.has(taskId) || this.startingIds.has(taskId) || this.terminalTasks.has(taskId)) throw new Error(`Background task ID ${taskId} is already in use.`);
		const now = Date.now();
		const record: BackgroundBatchRecord = {
			snapshot: { id, taskIds: [...taskIds], status: "starting", total: specs.length, completed: 0, failed: 0, cancelled: 0, startedAt: now, updatedAt: now },
			taskSnapshots: new Map(),
			expectedTaskCount: specs.length,
			notified: false,
			onSettled,
			lastAccessedAt: now,
		};
		this.batches.set(id, record);
		this.pruneRetention();
		try {
			const outcomes = await Promise.allSettled(specs.map((spec, index) => this.start({ ...spec, id: taskIds[index], batchId: id })));
			const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
			if (rejected) throw rejected.reason;
			const tasks = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<BackgroundTaskSnapshot>).value);
			this.refreshBatch(id);
			return { batch: cloneBatch(record.snapshot), tasks: tasks.map(cloneTask) };
		} catch (error) {
			await Promise.all(taskIds.map((taskId) => this.discard(taskId)));
			this.evictBatch(id);
			throw error;
		}
	}

	get(id: string): BackgroundTaskSnapshot | undefined {
		this.pruneRetention();
		const live = this.tasks.get(id)?.snapshot;
		if (live) return cloneTask(live);
		const terminal = this.touchTerminal(id);
		return terminal ? cloneTask(terminal.snapshot) : undefined;
	}

	list(): BackgroundTaskSnapshot[] {
		this.pruneRetention();
		return [...this.tasks.values()].map((task) => cloneTask(task.snapshot));
	}

	getBatch(id: string): BackgroundBatchSnapshot | undefined {
		this.pruneRetention();
		const record = this.batches.get(id);
		if (record) record.lastAccessedAt = Date.now();
		return record ? cloneBatch(record.snapshot) : undefined;
	}

	listBatches(): BackgroundBatchSnapshot[] {
		this.pruneRetention();
		return [...this.batches.values()].map((batch) => cloneBatch(batch.snapshot));
	}

	getBatchTasks(id: string): BackgroundTaskSnapshot[] {
		this.pruneRetention();
		const batch = this.batches.get(id);
		if (!batch) return [];
		batch.lastAccessedAt = Date.now();
		return batch.snapshot.taskIds
			.map((taskId) => batch.taskSnapshots.get(taskId))
			.filter((task): task is BackgroundTaskSnapshot => Boolean(task))
			.map(cloneTask);
	}

	consumeResult(id: string): BackgroundTaskResult | undefined {
		this.pruneRetention();
		const live = this.tasks.get(id)?.snapshot;
		if (live) return { snapshot: cloneTask(live), consumed: false };
		const record = this.touchTerminal(id);
		if (!record) return undefined;
		const consumed = record.resultConsumed;
		const result = cloneTask(record.snapshot);
		if (!consumed) {
			record.resultConsumed = true;
			record.snapshot = continuationSnapshot(record.snapshot);
			record.continuation = cloneTask(record.snapshot);
			this.recordBatchTask(record.snapshot);
		}
		return { snapshot: result, consumed };
	}

	consumeBatchResult(id: string): BackgroundBatchResult | undefined {
		this.pruneRetention();
		const record = this.batches.get(id);
		if (!record) return undefined;
		record.lastAccessedAt = Date.now();
		const tasks = this.getBatchTasks(id);
		const consumed = tasks.length > 0 && tasks.every((task) => task.resultConsumed);
		const resultTasks = tasks.map(cloneTask);
		if (!consumed) {
			for (const task of tasks) {
				const terminal = this.touchTerminal(task.id);
				if (terminal && !terminal.resultConsumed) {
					terminal.resultConsumed = true;
					terminal.snapshot = continuationSnapshot(terminal.snapshot);
					terminal.continuation = cloneTask(terminal.snapshot);
					this.recordBatchTask(terminal.snapshot);
				}
			}
		}
		return { batch: cloneBatch(record.snapshot), tasks: resultTasks, consumed };
	}

	async send(id: string, message: string, delivery: BackgroundDelivery): Promise<BackgroundTaskSnapshot> {
		if (!message.trim()) throw new Error("Background subagent message cannot be empty.");
		if (Buffer.byteLength(message, "utf8") > MAX_BACKGROUND_MESSAGE_BYTES) throw new Error(`Background subagent message exceeds ${MAX_BACKGROUND_MESSAGE_BYTES} bytes.`);
		if (this.followUpLocks.has(id)) throw new Error(`Background task ${id} already has a follow-up in progress.`);
		const live = this.tasks.get(id);
		if (!live && delivery === "steer") throw new Error(`Background task ${id} is not live; steer is only available for active tasks.`);
		if (live) {
			let sentLive = false;
			await this.withChildLock(live, async () => {
				// A terminal event may have won the lifecycle lock while this send
				// was being scheduled. In that case replay through the fresh-child
				// path below instead of touching a closed child.
				if (this.tasks.get(id) !== live) return;
				await live.send(message, delivery);
				sentLive = true;
			});
			if (!sentLive) {
				if (delivery === "steer") throw new Error(`Background task ${id} is no longer live; steer was not delivered.`);
				return this.startFollowUpWithLock(id, message);
			}
			if (live.snapshot.batchId) {
				const batch = this.batches.get(live.snapshot.batchId);
				if (batch) batch.notified = false;
			}
			this.recordBatchTask(live.snapshot);
			return { ...cloneTask(live.snapshot), status: "running" };
		}
		return this.startFollowUpWithLock(id, message);
	}

	private async startFollowUpWithLock(id: string, message: string): Promise<BackgroundTaskSnapshot> {
		if (this.followUpLocks.has(id)) throw new Error(`Background task ${id} already has a follow-up in progress.`);
		const followUp = this.startCompletedFollowUp(id, message);
		this.followUpLocks.set(id, followUp);
		try {
			const snapshot = await followUp;
			return { ...cloneTask(snapshot), status: "running" };
		} finally {
			if (this.followUpLocks.get(id) === followUp) this.followUpLocks.delete(id);
		}
	}

	private async startCompletedFollowUp(id: string, message: string): Promise<BackgroundTaskSnapshot> {
		this.pruneRetention();
		const record = this.touchTerminal(id);
		if (!record) throw new Error(`Background task ${id} was not found.`);
		if (record.snapshot.status !== "completed") throw new Error(`Background task ${id} is ${record.snapshot.status}.`);
		if (!record.createFollowUp) throw new Error(`Background task ${id} cannot be restarted for follow-up.`);
		this.ensureCapacity();
		const replayPrompt = buildFollowUpReplay(record.continuation, message);
		const nextSpec = await record.createFollowUp(replayPrompt);
		// Remove the old generation before startup so a very fast fresh child
		// cannot have its terminal record deleted after it settles.
		this.terminalTasks.delete(id);
		if (record.snapshot.batchId) {
			const batch = this.batches.get(record.snapshot.batchId);
			if (batch) batch.notified = false;
		}
		try {
			const next = await this.start({ ...nextSpec, id, batchId: record.snapshot.batchId, generation: (record.snapshot.generation ?? 0) + 1 });
			this.recordBatchTask(next);
			return next;
		} catch (error) {
			try { await nextSpec.onStartupFailure?.(); } catch { /* startup cleanup is best effort */ }
			this.putTerminal(id, record);
			this.recordBatchTask(record.snapshot);
			throw error;
		}
	}

	async cancel(id: string): Promise<BackgroundTaskSnapshot> {
		this.pruneRetention();
		const child = this.tasks.get(id);
		if (!child) {
			const terminal = this.terminalTasks.get(id)?.snapshot;
			if (!terminal) throw new Error(`Background task ${id} was not found.`);
			return cloneTask(terminal);
		}
		await this.withChildLock(child, async () => {
			await child.cancel();
			await this.terminalize({ child, snapshot: cloneTask(child.snapshot), executionToken: -1 });
		});
		return cloneTask(child.snapshot);
	}

	async cancelBatch(id: string): Promise<BackgroundBatchSnapshot> {
		const batch = this.batches.get(id);
		if (!batch) throw new Error(`Background batch ${id} was not found.`);
		await Promise.all(batch.snapshot.taskIds.map((taskId) => this.cancel(taskId).catch(() => undefined)));
		this.refreshBatch(id);
		return cloneBatch(batch.snapshot);
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shuttingDown = true;
		this.lifecycleEpoch++;
		this.shutdownPromise = (async () => {
			for (const reservation of this.pendingStarts.values()) reservation.controller.abort();
			await Promise.all([...this.pendingStarts.keys()].map((pending) => pending.catch(() => undefined)));
			await Promise.all([...this.tasks.values()].map((task) => task.close().catch(() => undefined)));
			this.tasks.clear();
			this.pendingStarts.clear();
			this.startingIds.clear();
			this.terminalTasks.clear();
			this.batches.clear();
		})().finally(() => {
			this.shuttingDown = false;
			this.shutdownPromise = undefined;
		});
		return this.shutdownPromise;
	}

	addReport(id: string, report: SupervisorReport): void {
		const task = this.tasks.get(id);
		if (task) {
			task.addReport(report);
			this.recordBatchTask(task.snapshot);
		}
	}

	private async discard(id: string): Promise<void> {
		const child = this.tasks.get(id);
		if (child) {
			await child.close().catch(() => undefined);
			this.tasks.delete(id);
		}
		// Batch startup rollback must not leave a partially published terminal ID.
		this.terminalTasks.delete(id);
		this.startingIds.delete(id);
	}

	private recordBatchTask(snapshot: BackgroundTaskSnapshot): void {
		if (!snapshot.batchId) return;
		const batch = this.batches.get(snapshot.batchId);
		if (!batch) return;
		const previous = batch.taskSnapshots.get(snapshot.id);
		const previousGeneration = previous?.generation ?? 0;
		const generation = snapshot.generation ?? 0;
		if (previous && (generation < previousGeneration || (generation === previousGeneration && snapshot.updatedAt < previous.updatedAt))) return;
		batch.taskSnapshots.set(snapshot.id, cloneTask(snapshot));
		batch.lastAccessedAt = Date.now();
		this.refreshBatch(snapshot.batchId);
	}

	private withChildLock<T>(child: RpcBackgroundChild, operation: () => Promise<T>): Promise<T> {
		const previous = this.childLocks.get(child) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.childLocks.set(child, current.then(() => undefined, () => undefined));
		return current;
	}

	private async terminalize(event: ChildTerminalEvent, source?: BackgroundTaskSpec): Promise<void> {
		const { child, snapshot } = event;
		// Both child identity and the immutable event snapshot matter: a delayed
		// completion from an old generation must not terminalize a fresh child.
		if (this.terminalizedChildren.has(child) || this.tasks.get(snapshot.id) !== child) return;
		if (event.executionToken >= 0 && !child.isTerminalEventCurrent(event.executionToken)) return;
		this.terminalizedChildren.add(child);
		this.tasks.delete(snapshot.id);
		const spec = source ?? this.childSpecs.get(child);
		const terminal = cloneTask(snapshot);
		this.putTerminal(snapshot.id, {
			snapshot: terminal,
			continuation: continuationSnapshot(terminal),
			resultConsumed: false,
			createFollowUp: spec?.createFollowUp,
			lastAccessedAt: Date.now(),
		});
		this.recordBatchTask(terminal);
		await child.close().catch(() => undefined);
		try { spec?.onSettled(terminal); } catch { /* notification must not break lifecycle cleanup */ }
		if (snapshot.batchId) this.refreshBatch(snapshot.batchId);
	}

	private refreshBatch(id: string): void {
		const batch = this.batches.get(id);
		if (!batch) return;
		const tasks = batch.snapshot.taskIds.map((taskId) => batch.taskSnapshots.get(taskId)).filter((task): task is BackgroundTaskSnapshot => Boolean(task));
		batch.snapshot.completed = tasks.filter((task) => task.status === "completed").length;
		batch.snapshot.failed = tasks.filter((task) => task.status === "failed").length;
		batch.snapshot.cancelled = tasks.filter((task) => task.status === "cancelled").length;
		batch.snapshot.updatedAt = Date.now();
		if (tasks.length < batch.expectedTaskCount) {
			batch.snapshot.status = "starting";
			return;
		}
		if (tasks.some((task) => task.status === "starting" || task.status === "running")) {
			batch.snapshot.status = "running";
			return;
		}
		batch.snapshot.status = batch.snapshot.failed > 0 ? "failed" : batch.snapshot.cancelled > 0 ? "cancelled" : "completed";
		if (!batch.notified) {
			batch.notified = true;
			try { batch.onSettled?.(cloneBatch(batch.snapshot)); } catch { /* notification is best effort */ }
		}
	}
}
