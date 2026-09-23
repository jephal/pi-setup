import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatadogCapabilities, createMemoryReadCapabilities, createNotesReadCapabilities, createFoveaCapabilities } from "./capability-adapters.ts";
import { boundCapabilityText, compactCapabilityResult, isPiProgramCapabilityAllowed, PI_PROGRAM_ALLOWED_CAPABILITIES, PI_PROGRAM_REJECTED_CAPABILITIES } from "./capabilities.ts";
import { MemoryStore } from "../src/memory/db.ts";

const context = (cwd: string) => ({ cwd, signal: undefined, model: undefined } as any);

test("the shared policy admits read classes and only the explicit repository side effects", () => {
	assert.equal(isPiProgramCapabilityAllowed({ name: "notes.search", access: "read-only" }), true);
	assert.equal(isPiProgramCapabilityAllowed({ name: "datadog.call", access: "dynamic-read" }), true);
	assert.equal(isPiProgramCapabilityAllowed({ name: "repo.edit", access: "side-effect" }), true);
	assert.equal(isPiProgramCapabilityAllowed({ name: "repo.write", access: "side-effect" }), true);
	assert.equal(isPiProgramCapabilityAllowed({ name: "repo.edit", access: "write" }), false);
	assert.equal(isPiProgramCapabilityAllowed({ name: "notes.write", access: "write" }), false);
	assert.equal(isPiProgramCapabilityAllowed({ name: "notes.write", access: "side-effect" }), false);
	assert.equal(isPiProgramCapabilityAllowed({ name: "datadog.create_monitor", access: "side-effect" }), false);
	assert.equal(isPiProgramCapabilityAllowed({ name: "unknown", access: "interactive" }), false);
	assert.equal(isPiProgramCapabilityAllowed({ name: "future.read", access: "read-only" }), false);
	assert.equal(PI_PROGRAM_ALLOWED_CAPABILITIES.has("future.read"), false);
	assert.deepEqual(PI_PROGRAM_REJECTED_CAPABILITIES.includes("bash"), true);
	assert.deepEqual(PI_PROGRAM_REJECTED_CAPABILITIES.includes("subagent"), true);
});

test("capability result normalization is text-only and byte bounded", () => {
	assert.equal(compactCapabilityResult({ text: "fovea text", details: { internal: true } }), "fovea text");
	assert.equal(compactCapabilityResult({ content: [{ type: "text", text: "visible" }, { type: "image", data: "secret-binary" }] }), "visible");
	const result = boundCapabilityText("🙂".repeat(100), 64);
	assert.ok(new TextEncoder().encode(result).byteLength <= 64);
	assert.match(result, /output truncated/);
});

test("the registry exposes the approved host capability catalog", () => {
	const names = [
		...createFoveaCapabilities(),
		...createNotesReadCapabilities(),
		...createMemoryReadCapabilities(),
		...createDatadogCapabilities({} as any),
	].map((capability) => capability.name);
	assert.deepEqual(names, [
		"fovea.sketch", "fovea.focus", "fovea.dwell", "fovea.impact",
		"notes.list", "notes.search", "notes.read", "memory.search", "memory.list",
		"datadog.search", "datadog.describe", "datadog.call",
	]);
});

test("fresh Memory reads do not create storage", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-capability-memory-fresh-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const list = createMemoryReadCapabilities().find((capability) => capability.name === "memory.list")!;
		assert.equal(await list.execute({}, context(root)), "No memories found.");
		await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(root, "memory"))), /ENOENT/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("read-only Memory search does not record retrieval usage", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-capability-memory-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const store = new MemoryStore(join(root, "memory", "memory.sqlite"));
	const record = store.save({ content: "Bridge memory stays read-only", scope: "user", category: "fact", tags: [], importance: 0.8 });
	store.close();
	try {
		const search = createMemoryReadCapabilities().find((capability) => capability.name === "memory.search")!;
		const result = await search.execute({ query: "bridge read-only" }, context(root));
		assert.match(String(result), /Bridge memory stays read-only/);
		const reopened = new MemoryStore(join(root, "memory", "memory.sqlite"));
		assert.equal(reopened.get(record.id)!.retrievalCount, 0);
		reopened.close();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("Datadog dynamic adapters delegate only catalog metadata and requested arguments", async () => {
	const calls: unknown[] = [];
	const provider = {
		async search(query: string, limit: number) { calls.push(["search", query, limit]); return { matches: [{ name: "datadog_logs", description: "read logs", parameters: { type: "object" } }] }; },
		async describe(name: string) { calls.push(["describe", name]); return { name, description: "read logs", parameters: { type: "object" } }; },
		async call(name: string, args: Record<string, unknown>) { calls.push(["call", name, args]); return { content: [{ type: "text", text: "remote result" }] }; },
	};
	const capabilities = createDatadogCapabilities(provider);
	assert.equal((await capabilities[0]!.execute({ query: "logs", limit: 2 }, context(process.cwd())) as any).matches[0].name, "datadog_logs");
	assert.equal((await capabilities[1]!.execute({ name: "datadog_logs" }, context(process.cwd())) as any).name, "datadog_logs");
	const called = await capabilities[2]!.execute({ name: "datadog_logs", arguments: { query: "status:error" } }, context(process.cwd())) as any;
	assert.equal(called.content[0].text, "remote result");
	assert.deepEqual(calls, [
		["search", "logs", 2],
		["describe", "datadog_logs"],
		["call", "datadog_logs", { query: "status:error" }],
	]);
});
