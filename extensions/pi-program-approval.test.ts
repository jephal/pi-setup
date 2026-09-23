import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPiProgramSideEffectsAllowed,
	runPiProgramWithApprovals,
	shouldSuspendPiProgramSideEffect,
	subscribePiProgramApprovalMode,
	validatePiProgramSideEffectScript,
	type PiProgramSuspension,
} from "./pi-program-approval.ts";

function harness(confirm: (title: string, message: string) => Promise<boolean>, hasUI = true) {
	const listeners = new Map<string, (value: unknown) => void>();
	const events: unknown[] = [];
	const pi = { events: {
		on(name: string, listener: (value: unknown) => void) { listeners.set(name, listener); },
		emit(name: string, value: unknown) { events.push([name, value]); },
	} } as any;
	const ctx = { hasUI, ui: { confirm } } as any;
	return { pi, ctx, events, listeners };
}

function request(tool: string, key = "write-step"): PiProgramSuspension {
	return {
		key,
		tool,
		interaction: { kind: "confirm", title: `Approve ${tool}?`, detail: "update the project", props: { calls: [{ tool, reason: "update the project", args: { path: "file.txt", content: "new" } }] } },
	};
}

test("tracks approval-mode:changed and applies explicit side-effect classes", () => {
	const { pi, listeners } = harness(async () => true);
	const getMode = subscribePiProgramApprovalMode(pi);
	assert.equal(getMode(), undefined);
	listeners.get("approval-mode:changed")!({ mode: "manual" });
	assert.equal(getMode(), "manual");
	assert.equal(shouldSuspendPiProgramSideEffect("repo.write", getMode()), true);
	listeners.get("approval-mode:changed")!({ mode: "approve" });
	assert.equal(shouldSuspendPiProgramSideEffect("repo.edit", getMode()), true);
	listeners.get("approval-mode:changed")!({ mode: "auto" });
	assert.equal(shouldSuspendPiProgramSideEffect("repo.write", getMode()), false);
	assertPiProgramSideEffectsAllowed(["repo.write"], getMode(), true);
	listeners.get("approval-mode:changed")!({ mode: "review" });
	assert.throws(() => assertPiProgramSideEffectsAllowed(["repo.edit"], getMode(), true), /read-only/);
	listeners.get("approval-mode:changed")!({ mode: "plan" });
	assert.throws(() => assertPiProgramSideEffectsAllowed(["repo.write"], getMode(), true), /read-only/);
});

test("resolves approval and resumes CallScript with its prior state", async () => {
	const { pi, ctx, events } = harness(async (title, message) => {
		assert.equal(title, "Approve repo.write?");
		assert.match(message, /Path: file.txt/);
		assert.match(message, /Reason: update the project/);
		return true;
	});
	const state = { version: "2", steps: { read: { status: "done" } } };
	const calls: unknown[] = [];
	const result = await runPiProgramWithApprovals(async (options) => {
		calls.push(options);
		if (calls.length === 1) return { status: "suspended", state, suspensions: [request("repo.write")] };
		assert.equal(options.state, state);
		assert.deepEqual(options.resolutions, { "write-step": true });
		return { status: "ok", state: options.state };
	}, { pi, ctx, getMode: () => "manual" });
	assert.equal(result.status, "ok");
	assert.equal(calls.length, 2);
	assert.deepEqual(events, [
		["herdr:blocked", { active: true, label: "Waiting for CallScript approval" }],
		["herdr:blocked", { active: false, label: "Waiting for CallScript approval" }],
	]);
});

test("denials are sent back as false resolutions and never authorize the operation", async () => {
	const { pi, ctx } = harness(async () => false);
	let calls = 0;
	const state = { version: "2", steps: {} };
	const result = await runPiProgramWithApprovals(async (options) => {
		calls++;
		if (calls === 1) return { status: "suspended", state, suspensions: [request("repo.edit")] };
		assert.equal(options.state, state);
		assert.deepEqual(options.resolutions, { "write-step": false });
		return { status: "error", state };
	}, { pi, ctx, getMode: () => "approve" });
	assert.equal(result.status, "error");
	assert.equal(calls, 2);
});

test("side-effect programs reject detached runs before any host call", () => {
	assert.throws(() => validatePiProgramSideEffectScript({ await: false, steps: [{ call: "repo.write", reason: "write" }] }), /Detached CallScript programs are unsupported/);
	assert.throws(() => validatePiProgramSideEffectScript({ steps: [{ call: "repo.write", reason: "write", await: false }] }), /cannot be detached/);
});

test("an approval preview that cannot fit all side-effect input fails closed", async () => {
	let confirmations = 0;
	const { pi, ctx } = harness(async () => { confirmations++; return true; });
	const calls = ["first", "second"].map((path) => ({
		tool: "repo.write",
		reason: "large write",
		args: { path: `${path}.txt`, content: "x".repeat(30_000) },
	}));
	await assert.rejects(runPiProgramWithApprovals(async () => ({
		status: "suspended",
		suspensions: [{
			key: "large-writes",
			tool: "repo.write",
			interaction: { kind: "confirm", props: { calls } },
		}],
	}), { pi, ctx, getMode: () => "manual" }), /display limit.*operation blocked/);
	assert.equal(confirmations, 0);
});

test("headless sessions and unknown approval mode fail closed", async () => {
	for (const mode of ["manual", "approve", "auto"] as const) {
		assert.throws(() => assertPiProgramSideEffectsAllowed(["repo.write"], mode, false), /without interactive approval UI/);
	}
	assert.throws(() => assertPiProgramSideEffectsAllowed(["repo.write"], undefined, true), /unavailable/);
	const { pi, ctx } = harness(async () => true, false);
	await assert.rejects(runPiProgramWithApprovals(async () => ({ status: "suspended", suspensions: [request("repo.write")] }), {
		pi,
		ctx,
		getMode: () => "auto",
	}), /Interactive approval UI is required/);
});

test("an aborted outer execution does not run or resume the CallScript program", async () => {
	const controller = new AbortController();
	controller.abort();
	const { pi, ctx } = harness(async () => true);
	let calls = 0;
	await assert.rejects(runPiProgramWithApprovals(async () => { calls++; return { status: "ok" }; }, {
		pi,
		ctx,
		getMode: () => "auto",
		signal: controller.signal,
	}), /Operation aborted/);
	assert.equal(calls, 0);
});
