import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withHerdrBlock } from "./herdr-blocking.ts";
import { boundCapabilityText, PI_PROGRAM_SIDE_EFFECT_CAPABILITY_NAMES } from "./capabilities.ts";
import { MAX_REPO_EDIT_TEXT_BYTES, MAX_REPO_WRITE_BYTES } from "./capability-adapters.ts";

export type PiProgramApprovalMode = "manual" | "approve" | "auto" | "review" | "plan";

export interface PiProgramSuspension {
	key: string;
	tool?: string;
	interaction?: {
		kind?: string;
		title?: string;
		detail?: string;
		props?: unknown;
	};
}

export interface PiProgramRunOptions {
	state?: unknown;
	resolutions?: Record<string, boolean>;
}

export interface PiProgramRunResult {
	status: string;
	state?: unknown;
	suspensions?: PiProgramSuspension[];
}

export type PiProgramRunner = (options: PiProgramRunOptions) => Promise<PiProgramRunResult>;

export function isPiProgramSideEffect(name: string): boolean {
	return (PI_PROGRAM_SIDE_EFFECT_CAPABILITY_NAMES as readonly string[]).includes(name);
}

/** Subscribe to the approval extension's authoritative mode-change event. */
export function subscribePiProgramApprovalMode(pi: Pick<ExtensionAPI, "events">): () => PiProgramApprovalMode | undefined {
	let mode: PiProgramApprovalMode | undefined;
	const events = (pi as Pick<ExtensionAPI, "events"> | { events?: ExtensionAPI["events"] }).events;
	if (!events) return () => mode;
	events.on("approval-mode:changed", (data) => {
		if (!data || typeof data !== "object" || !("mode" in data)) return;
		const value = (data as { mode?: unknown }).mode;
		if (value === "manual" || value === "approve" || value === "auto" || value === "review" || value === "plan") mode = value;
	});
	return () => mode;
}

export function shouldSuspendPiProgramSideEffect(name: string, mode: PiProgramApprovalMode | undefined): boolean {
	return isPiProgramSideEffect(name) && (mode === "manual" || mode === "approve");
}

/** Require one intentional operation per side-effect step, with an auditable reason. */
export function validatePiProgramSideEffectScript(script: { await?: boolean; steps: unknown[] }): void {
	if (script.await === false) throw new Error("Detached CallScript programs are unsupported for side effects.");
	for (const [index, value] of script.steps.entries()) {
		if (!value || typeof value !== "object") continue;
		const step = value as Record<string, unknown>;
		if (typeof step.call !== "string" || !isPiProgramSideEffect(step.call)) continue;
		if (step.each !== undefined) throw new Error(`Side-effect step ${index + 1} cannot use each fan-out; make one explicit operation per step.`);
		if (step.await === false) throw new Error(`Side-effect step ${index + 1} cannot be detached.`);
		if (typeof step.reason !== "string" || !step.reason.trim()) throw new Error(`Side-effect step ${index + 1} requires a non-empty reason.`);
	}
}

/** Reject before execution if a side effect cannot be explicitly authorized. */
export function assertPiProgramSideEffectsAllowed(
	toolNames: Iterable<string>,
	mode: PiProgramApprovalMode | undefined,
	hasUI: boolean,
): void {
	const sideEffects = [...new Set([...toolNames].filter(isPiProgramSideEffect))];
	if (sideEffects.length === 0) return;
	if (!hasUI) throw new Error("Repository writes are disabled without interactive approval UI.");
	if (mode === "review" || mode === "plan") throw new Error(`${mode === "review" ? "Review" : "Plan"} mode is read-only; repository writes are blocked.`);
	if (mode === undefined) throw new Error("Approval mode is unavailable; repository writes are blocked.");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function previewValue(value: unknown, budget: number): string {
	if (typeof value === "string") return boundCapabilityText(value, budget);
	try {
		return boundCapabilityText(JSON.stringify(value, null, 2) ?? String(value), budget);
	} catch {
		return boundCapabilityText(String(value), budget);
	}
}

function approvalPayload(value: unknown, budget: number): string {
	if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > budget) {
		throw new Error("Approval preview cannot show the complete side-effect content; operation blocked.");
	}
	return value;
}

const MAX_APPROVAL_MESSAGE_BYTES = 48 * 1024;

function suspensionMessage(suspension: PiProgramSuspension): { title: string; message: string } {
	const interaction = suspension.interaction;
	const props = interaction?.props && typeof interaction.props === "object" ? interaction.props as Record<string, unknown> : {};
	const calls = Array.isArray(props.calls) ? props.calls as Array<Record<string, unknown>> : [];
	const pieces = calls.map((call, index) => {
		const args = call.args && typeof call.args === "object" ? call.args as Record<string, unknown> : {};
		const path = typeof args.path === "string" ? args.path : "(missing path)";
		const reason = typeof call.reason === "string" ? call.reason : interaction?.detail;
		const lines = [`Operation: ${String(call.tool ?? suspension.tool ?? "unknown")}`, `Path: ${path}`];
		if (reason) lines.push(`Reason: ${previewValue(reason, 2_000)}`);
		if (call.tool === "repo.edit" && Array.isArray(args.edits)) {
			for (const [editIndex, editValue] of args.edits.entries()) {
				const edit = editValue && typeof editValue === "object" ? editValue as Record<string, unknown> : {};
				lines.push(`Edit ${editIndex + 1} old:\n${approvalPayload(edit.oldText, MAX_REPO_EDIT_TEXT_BYTES)}`);
				lines.push(`Edit ${editIndex + 1} new:\n${approvalPayload(edit.newText, MAX_REPO_EDIT_TEXT_BYTES)}`);
			}
		} else if (call.tool === "repo.write") {
			lines.push(`New content:\n${approvalPayload(args.content, MAX_REPO_WRITE_BYTES)}`);
		}
		return `${calls.length > 1 ? `Operation ${index + 1}\n` : ""}${lines.join("\n")}`;
	});
	const message = pieces.length ? pieces.join("\n\n") : interaction?.detail || "Confirm this suspended CallScript operation.";
	if (new TextEncoder().encode(message).byteLength > MAX_APPROVAL_MESSAGE_BYTES) {
		throw new Error("Approval preview exceeds the display limit; operation blocked rather than approving unseen content.");
	}
	return {
		title: interaction?.title || `Approve ${suspension.tool ?? "CallScript operation"}?`,
		message,
	};
}

async function confirmAbortably(
	pi: Pick<ExtensionAPI, "events">,
	ctx: ExtensionContext,
	title: string,
	message: string,
	signal?: AbortSignal,
): Promise<boolean> {
	throwIfAborted(signal);
	if (!ctx.hasUI) throw new Error("Interactive approval UI is required; operation blocked.");
	return withHerdrBlock(pi, "Waiting for CallScript approval", async () => {
		const confirmation = ctx.ui.confirm(title, message);
		if (!signal) return confirmation;
		return new Promise<boolean>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(new Error("Operation aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			confirmation.then(
				(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
				(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
			);
		});
	});
}

/** Keep the CallScript state and resolve every approval before returning to Pi. */
export async function runPiProgramWithApprovals(
	run: PiProgramRunner,
	options: {
		pi: Pick<ExtensionAPI, "events">;
		ctx: ExtensionContext;
		getMode: () => PiProgramApprovalMode | undefined;
		beforeConfirm?: (suspension: PiProgramSuspension) => void | Promise<void>;
		signal?: AbortSignal;
	},
): Promise<PiProgramRunResult> {
	let state: unknown;
	let resolutions: Record<string, boolean> = {};
	for (;;) {
		throwIfAborted(options.signal);
		const result = await run({ state, resolutions });
		throwIfAborted(options.signal);
		if (result.status !== "suspended") return result;
		const suspensions = result.suspensions ?? [];
		if (suspensions.length === 0) throw new Error("CallScript suspended without a resolvable approval request.");
		const nextResolutions: Record<string, boolean> = {};
		for (const suspension of suspensions) {
			throwIfAborted(options.signal);
			if (!suspension.interaction) throw new Error("CallScript requested a non-interactive suspension; operation blocked.");
			await options.beforeConfirm?.(suspension);
			throwIfAborted(options.signal);
			const { title, message } = suspensionMessage(suspension);
			const approved = await confirmAbortably(options.pi, options.ctx, title, message, options.signal);
			throwIfAborted(options.signal);
			if (approved && isPiProgramSideEffect(suspension.tool ?? "")) {
				assertPiProgramSideEffectsAllowed([suspension.tool!], options.getMode(), options.ctx.hasUI);
			}
			nextResolutions[suspension.key] = approved;
		}
		state = result.state;
		resolutions = nextResolutions;
	}
}
