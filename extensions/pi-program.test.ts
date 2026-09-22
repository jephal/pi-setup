import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import piProgramExtension, { boundText, compactToolResult, createPiProgramTool, createPiProgramTools, executableExists, PI_PROGRAM_CAPABILITIES } from "./pi-program.ts";

function context(cwd: string) {
	return { cwd, signal: undefined, model: undefined } as any;
}

test("registers only the pi_program host tool", () => {
	const definitions: Array<{ name: string }> = [];
	const fakePi = { registerTool(definition: { name: string }) { definitions.push(definition); } };
	piProgramExtension(fakePi as unknown as ExtensionAPI);
	assert.deepEqual(definitions.map((definition) => definition.name), ["pi_program"]);
});

test("mounts the four core capabilities plus the shared search router", () => {
	const tools = createPiProgramTools(process.cwd(), undefined, context(process.cwd()));
	assert.deepEqual(tools.map((entry) => entry.name), [...PI_PROGRAM_CAPABILITIES]);
	assert.equal(tools.some((entry) => /bash|shell|write|edit|mcp|notes|memory|subagent/i.test(entry.name)), false);
});

test("binds nested repository reads to the execution cwd", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-cwd-"));
	try {
		await writeFile(join(cwd, "marker.txt"), "from execution cwd\n", "utf8");
		const read = createPiProgramTools(cwd, undefined, context(cwd)).find((entry) => entry.name === "repo.read");
		assert.ok(read);
		assert.equal(await read.execute({ path: "marker.txt" }, {} as any), "from execution cwd\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("checks the outer abort signal before a nested call", async () => {
	const controller = new AbortController();
	controller.abort();
	const read = createPiProgramTools(process.cwd(), controller.signal, context(process.cwd())).find((entry) => entry.name === "repo.read");
	assert.ok(read);
	await assert.rejects(read.execute({ path: "does-not-matter" }, {} as any), /Operation aborted/);
});

test("keeps nested results compact and textual", () => {
	assert.equal(compactToolResult({ content: [{ type: "text", text: "one" }, { type: "image", data: "ignored" }] }), "one");
	assert.equal(compactToolResult({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }), "one\ntwo");
	assert.equal(compactToolResult({ content: [{ type: "image", data: "large-binary-payload" }] }), "(non-text output omitted)");
});

test("keeps bounded output within its UTF-8 byte budget", () => {
	const result = boundText("🙂".repeat(100), 64);
	assert.ok(new TextEncoder().encode(result).byteLength <= 64);
	assert.match(result, /output truncated/);
});

test("uses CallScript's documented schema and a compact capability card", () => {
	const definition = createPiProgramTool();
	const schema = definition.parameters as any;
	assert.deepEqual(schema.required, ["script"]);
	assert.equal(schema.additionalProperties, false);
	assert.equal(schema.properties.script.type, "string");
	assert.equal(Value.Check(schema, { script: "ok" }), true);
	assert.equal(Value.Check(schema, { script: "ok", extra: true }), false);
	assert.match(definition.description, /repo\.read/);
	assert.match(definition.description, /25 calls per fan-out/);
	assert.match(definition.description, /50 calls total/);
});

test("rejects malformed nested arguments before Pi execution", async () => {
	const tools = createPiProgramTools(process.cwd(), undefined, context(process.cwd()));
	const read = tools.find((entry) => entry.name === "repo.read");
	const grep = tools.find((entry) => entry.name === "repo.grep");
	assert.ok(read);
	assert.ok(grep);
	await assert.rejects(read.execute({ path: 42 } as any, {} as any), /Invalid arguments for repo\.read/);
	await assert.rejects(grep.execute({ pattern: "x", limit: "not-a-number" } as any, {} as any), /Invalid arguments for repo\.grep/);
	await assert.rejects(grep.execute({ pattern: "x", limit: 2_001 } as any, {} as any), /result limit/);
	await assert.rejects(grep.execute({ pattern: "x", context: 21 } as any, {} as any), /context limit/);
});

test("runs read, find, grep, and ls programs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-tools-"));
	try {
		await mkdir(join(cwd, "nested"));
		await writeFile(join(cwd, "marker.txt"), "needle here\n", "utf8");
		await writeFile(join(cwd, "nested", "other.txt"), "other\n", "utf8");
		const result = await createPiProgramTool().execute(
			"program",
			{ script: "const files = await repo.find({ pattern: '*.txt' }); const matches = await repo.grep({ pattern: 'needle', path: '.' }); const routed = await repo.search({ query: 'needle', mode: 'text', path: '.' }); const autoFiles = await repo.search({ query: '*.txt', path: '.' }); const explicitFiles = await repo.search({ query: 'marker.txt', mode: 'files', path: '.' }); const entries = await repo.ls({ path: '.' }); return files + '\\n' + matches + '\\n' + routed + '\\n' + autoFiles + '\\n' + explicitFiles + '\\n' + entries;" },
			undefined,
			undefined,
			context(cwd),
		);
		assert.match(result.content[0].text, /marker\.txt/);
		assert.match(result.content[0].text, /marker\.txt:1: needle here/);
		assert.match(result.content[0].text, /nested\//);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runs a read-only program and returns only compact text", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-output-"));
	try {
		await writeFile(join(cwd, "marker.txt"), "program output\n", "utf8");
		const result = await createPiProgramTool().execute(
			"program",
			{ script: 'const text = await repo.read({ path: "marker.txt" }); return text;' },
			undefined,
			undefined,
			context(cwd),
		);
		assert.deepEqual(result.content, [{ type: "text", text: "program output\n" }]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("rejects traversal, outside absolute paths, and escaping symlinks", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-boundary-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-program-outside-"));
	try {
		await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
		await symlink(join(outside, "secret.txt"), join(cwd, "escape.txt"));
		await symlink(join(outside, "secret.txt"), join(cwd, "capture\u202fAM.txt"));
		const run = (script: string) => createPiProgramTool().execute("program", { script }, undefined, undefined, context(cwd));
		const traversal = await run('return await repo.read({ path: "../outside-secret.txt" });');
		const absolute = await run(`return await repo.read({ path: ${JSON.stringify(join(outside, "secret.txt"))} });`);
		const symlinkResult = await run('return await repo.read({ path: "escape.txt" });');
		const fallbackSymlinkResult = await run('return await repo.read({ path: "capture AM.txt" });');
		assert.match(traversal.content[0].text, /outside the execution repository/);
		assert.match(absolute.content[0].text, /outside the execution repository/);
		assert.match(symlinkResult.content[0].text, /outside the execution repository/);
		assert.match(fallbackSymlinkResult.content[0].text, /outside the execution repository/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("does not download missing fd or rg binaries", () => {
	const env = { ...process.env, PATH: "" };
	assert.equal(executableExists("fd", env), false);
	assert.equal(executableExists("rg", env), false);
});

test("normalizes nested failures instead of rejecting the host tool", async () => {
	const result = await createPiProgramTool().execute(
		"program",
		{ script: 'return await repo.read({ path: "missing-file.txt" });' },
		undefined,
		undefined,
		context(process.cwd()),
	);
	assert.match(result.content[0].text, /^Program error/);
});

test("the intrinsic mount boundary rejects writes even when nested Pi events are bypassed", async () => {
	const definition = createPiProgramTool();
	const result = await definition.execute(
		"program",
		{ script: 'await bash({ command: "touch should-not-exist" });' },
		undefined,
		undefined,
		context(process.cwd()),
	);
	assert.match(result.content[0].text, /^Invalid program:/);
	assert.match(result.content[0].text, /Unknown tool "bash"/);
});
