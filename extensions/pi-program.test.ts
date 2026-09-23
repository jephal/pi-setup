import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import piProgramExtension, { boundText, compactToolResult, createPiProgramTool, createPiProgramTools, executableExists, PI_PROGRAM_CAPABILITIES } from "./pi-program.ts";
import { MemoryStore } from "../src/memory/db.ts";

function context(cwd: string) {
	return { cwd, signal: undefined, model: undefined } as any;
}

function interactiveContext(cwd: string, confirm: (title: string, message: string) => Promise<boolean>) {
	return { cwd, signal: undefined, model: undefined, hasUI: true, ui: { confirm } } as any;
}

function fakePi(events: unknown[] = []) {
	return { events: { emit(name: string, data: unknown) { events.push([name, data]); } } } as any;
}

test("registers only the pi_program host tool", () => {
	const definitions: Array<{ name: string }> = [];
	const fakePi = { registerTool(definition: { name: string }) { definitions.push(definition); } };
	piProgramExtension(fakePi as unknown as ExtensionAPI);
	assert.deepEqual(definitions.map((definition) => definition.name), ["pi_program"]);
});

test("mounts the explicit capability registry and keeps other side effects direct-only", () => {
	const tools = createPiProgramTools(process.cwd(), undefined, context(process.cwd()));
	assert.deepEqual(tools.map((entry) => entry.name), [...PI_PROGRAM_CAPABILITIES]);
	assert.ok(tools.some((entry) => entry.name === "fovea.focus"));
	assert.ok(tools.some((entry) => entry.name === "notes.search"));
	assert.ok(tools.some((entry) => entry.name === "memory.list"));
	assert.ok(tools.some((entry) => entry.name === "datadog.call"));
	assert.ok(tools.some((entry) => entry.name === "repo.edit"));
	assert.ok(tools.some((entry) => entry.name === "repo.write"));
	assert.equal(tools.some((entry) => ["bash", "shell", "write", "edit", "notes.write", "memory.save", "subagent"].includes(entry.name)), false);
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
	assert.match(definition.description, /fovea\./);
	assert.match(definition.description, /datadog\.(search|describe|call)/);
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

test("runs Notes and Memory context capabilities through CallScript", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-context-"));
	const previousNotes = process.env.NOTES_PATH;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.NOTES_PATH = cwd;
	process.env.PI_CODING_AGENT_DIR = cwd;
	const store = new MemoryStore(join(cwd, "memory", "memory.sqlite"));
	store.save({ content: "CallScript context bridge memory", scope: "user", category: "fact", tags: [], importance: 0.8 });
	store.close();
	try {
		await writeFile(join(cwd, "context.md"), "Context bridge note\\n", "utf8");
		const result = await createPiProgramTool().execute(
			"program",
			{ script: 'const note = await notes.read({ path: "context.md" }); const memories = await memory.search({ query: "context bridge" }); return note + memories;' },
			undefined,
			undefined,
			context(cwd),
		);
		assert.match(result.content[0].text, /Context bridge note/);
		assert.match(result.content[0].text, /CallScript context bridge memory/);
	} finally {
		if (previousNotes === undefined) delete process.env.NOTES_PATH;
		else process.env.NOTES_PATH = previousNotes;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runs bounded repository edit/write capabilities in Auto without prompting", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-repo-write-"));
	let confirmations = 0;
	try {
		await writeFile(join(cwd, "edit.txt"), "old text\n", "utf8");
		const tool = createPiProgramTool(() => "auto", fakePi());
		const written = await tool.execute("program", {
			script: 'await repo.write({ path: "created.txt", content: "new file\\n" }, { reason: "create the requested file" }); return "written";',
		}, undefined, undefined, interactiveContext(cwd, async () => { confirmations++; return true; }));
		const edited = await tool.execute("program", {
			script: 'await repo.edit({ path: "edit.txt", edits: [{ oldText: "old text", newText: "new text" }] }, { reason: "update the requested text" }); return "edited";',
		}, undefined, undefined, interactiveContext(cwd, async () => { confirmations++; return true; }));
		assert.match(written.content[0].text, /written/);
		assert.match(edited.content[0].text, /edited/);
		assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "created.txt"), "utf8")), "new file\n");
		assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "edit.txt"), "utf8")), "new text\n");
		assert.equal(confirmations, 0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Manual and Approve modes confirm each operation and resume the same program", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-manual-approval-"));
	const blockerEvents: unknown[] = [];
	let confirmations = 0;
	let approvalMode: "manual" | "approve" = "manual";
	const tool = createPiProgramTool(() => approvalMode, fakePi(blockerEvents));
	const ctx = interactiveContext(cwd, async (title, message) => {
		confirmations++;
		assert.match(title, /repo\.write/);
		assert.match(message, /Path: approved\.txt/);
		assert.match(message, /Reason: requested change/);
		assert.match(message, /New content:/);
		assert.match(message, /approved content/);
		return true;
	});
	const script = 'await repo.write({ path: "approved.txt", content: "approved content" }, { reason: "requested change" }); return "complete";';
	try {
		for (approvalMode of ["manual", "approve"]) {
			const result = await tool.execute("program", { script }, undefined, undefined, ctx);
			assert.equal(result.content[0].text, "complete");
			assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "approved.txt"), "utf8")), "approved content");
		}
		assert.equal(confirmations, 2);
		assert.equal(blockerEvents.filter(([name, event]) => name === "herdr:blocked" && (event as any).active).length, 2);
		assert.equal(blockerEvents.filter(([name, event]) => name === "herdr:blocked" && !(event as any).active).length, 2);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("multiple side effects in one program each receive a decision without replaying settled edits", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-multiple-approvals-"));
	let confirmations = 0;
	try {
		await writeFile(join(cwd, "first.txt"), "before", "utf8");
		const result = await createPiProgramTool(() => "manual", fakePi()).execute(
			"program",
			{ script: 'await repo.edit({ path: "first.txt", edits: [{ oldText: "before", newText: "after" }] }, { reason: "edit first file" }); await repo.write({ path: "second.txt", content: "second" }, { reason: "write second file" }); return "complete";' },
			undefined,
			undefined,
			interactiveContext(cwd, async (_title, message) => { confirmations++; assert.match(message, /Reason: (edit first file|write second file)/); return true; }),
		);
		assert.equal(result.content[0].text, "complete");
		assert.equal(confirmations, 2);
		assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "first.txt"), "utf8")), "after");
		assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "second.txt"), "utf8")), "second");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("repo.write approval preview shows its full maximum-size content", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-write-preview-full-"));
	const content = "full-write-content-" + "w".repeat(32 * 1024 - "full-write-content-".length);
	let message = "";
	try {
		const result = await createPiProgramTool(() => "manual", fakePi()).execute(
			"program",
			{ script: `await repo.write(${JSON.stringify({ path: "large.txt", content })}, { reason: "inspect the complete write" });` },
			undefined,
			undefined,
			interactiveContext(cwd, async (_title, preview) => { message = preview; return false; }),
		);
		assert.match(result.content[0].text, /declined to run "repo\.write"/);
		assert.ok(message.includes(content), "approval preview must contain the complete authorized file contents");
		assert.doesNotMatch(message, /output truncated/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("repo.edit approval preview shows all bounded replacement text", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-edit-preview-full-"));
	const edits = Array.from({ length: 4 }, (_, index) => {
		const oldPrefix = `old-${index}-`;
		const newPrefix = `new-${index}-`;
		return {
			oldText: oldPrefix + "o".repeat(4 * 1024 - oldPrefix.length),
			newText: newPrefix + "n".repeat(4 * 1024 - newPrefix.length),
		};
	});
	let message = "";
	try {
		await writeFile(join(cwd, "large.txt"), "before", "utf8");
		const result = await createPiProgramTool(() => "manual", fakePi()).execute(
			"program",
			{ script: `await repo.edit(${JSON.stringify({ path: "large.txt", edits })}, { reason: "inspect all replacements" });` },
			undefined,
			undefined,
			interactiveContext(cwd, async (_title, preview) => { message = preview; return false; }),
		);
		assert.match(result.content[0].text, /declined to run "repo\.edit"/);
		assert.ok(edits.every(({ oldText, newText }) => message.includes(oldText) && message.includes(newText)));
		assert.doesNotMatch(message, /output truncated/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("the edit approval preview includes the exact bounded old and new text", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-edit-preview-"));
	try {
		await writeFile(join(cwd, "preview.txt"), "before", "utf8");
		const result = await createPiProgramTool(() => "manual", fakePi()).execute(
			"program",
			{ script: 'await repo.edit({ path: "preview.txt", edits: [{ oldText: "before", newText: "after" }] }, { reason: "replace the requested phrase" });' },
			undefined,
			undefined,
			interactiveContext(cwd, async (_title, message) => {
				assert.match(message, /Path: preview\.txt/);
				assert.match(message, /Reason: replace the requested phrase/);
				assert.match(message, /Edit 1 old:\nbefore/);
				assert.match(message, /Edit 1 new:\nafter/);
				return true;
			}),
		);
		assert.match(result.content[0].text, /Successfully replaced/);
		assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "preview.txt"), "utf8")), "after");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a denied side-effect approval resumes as a denial without writing", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-deny-"));
	try {
		const result = await createPiProgramTool(() => "approve", fakePi()).execute(
			"program",
			{ script: 'await repo.write({ path: "denied.txt", content: "must not be written" }, { reason: "test denial" });' },
			undefined,
			undefined,
			interactiveContext(cwd, async () => false),
		);
		assert.match(result.content[0].text, /declined to run "repo\.write"/);
		await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(cwd, "denied.txt"))), /ENOENT/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Auto honors explicit suspend:true but otherwise writes without approval", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-auto-suspend-"));
	let confirmations = 0;
	try {
		const result = await createPiProgramTool(() => "auto", fakePi()).execute(
			"program",
			{ script: 'await repo.write({ path: "suspended.txt", content: "confirmed" }, { reason: "explicit scrutiny", suspend: true });' },
			undefined,
			undefined,
			interactiveContext(cwd, async (_title, message) => { confirmations++; assert.match(message, /explicit scrutiny/); return true; }),
		);
		assert.equal(confirmations, 1);
		assert.match(result.content[0].text, /Successfully wrote/);
		assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "suspended.txt"), "utf8")), "confirmed");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Review and Plan modes block writes before confirmation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-read-only-mode-"));
	let confirmations = 0;
	try {
		for (const mode of ["review", "plan"] as const) {
			const result = await createPiProgramTool(() => mode, fakePi()).execute(
				"program",
				{ script: 'await repo.write({ path: "blocked.txt", content: "blocked" }, { reason: "test restricted mode" });' },
				undefined,
				undefined,
				interactiveContext(cwd, async () => { confirmations++; return true; }),
			);
			assert.match(result.content[0].text, /mode is read-only/);
		}
		assert.equal(confirmations, 0);
		await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(cwd, "blocked.txt"))), /ENOENT/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("headless Auto cannot authorize a repository write", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-headless-"));
	try {
		const result = await createPiProgramTool(() => "auto", fakePi()).execute(
			"program",
			{ script: 'await repo.write({ path: "headless.txt", content: "blocked" }, { reason: "headless test" });' },
			undefined,
			undefined,
			{ cwd, signal: undefined, model: undefined, hasUI: false } as any,
		);
		assert.match(result.content[0].text, /disabled without interactive approval UI/);
		await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(cwd, "headless.txt"))), /ENOENT/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("rejects write fan-out, oversized content, and paths outside the repository", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-write-bounds-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-program-write-outside-"));
	let confirmations = 0;
	const tool = createPiProgramTool(() => "auto", fakePi());
	try {
		const fanout = await tool.execute("program", {
			script: 'await Promise.all([{ path: "one.txt", content: "one" }, { path: "two.txt", content: "two" }].map(item => repo.write({ path: item.path, content: item.content }, { reason: "fan out writes" })));',
		}, undefined, undefined, interactiveContext(cwd, async () => { confirmations++; return true; }));
		assert.match(fanout.content[0].text, /cannot use each fan-out/);
		const oversized = await tool.execute("program", {
			script: `await repo.write(${JSON.stringify({ path: "oversized.txt", content: "x".repeat(32 * 1024 + 1) })}, { reason: "test size bound" });`,
		}, undefined, undefined, interactiveContext(cwd, async () => { confirmations++; return true; }));
		assert.match(oversized.content[0].text, /Invalid arguments for repo\.write|content exceeds/);
		const tooManyEdits = Array.from({ length: 11 }, () => ({ oldText: "old", newText: "new" }));
		const editLimit = await tool.execute("program", {
			script: `await repo.edit(${JSON.stringify({ path: "many-edits.txt", edits: tooManyEdits })}, { reason: "test edit count" });`,
		}, undefined, undefined, interactiveContext(cwd, async () => { confirmations++; return true; }));
		assert.match(editLimit.content[0].text, /Invalid arguments for repo\.edit/);
		const missingReason = await tool.execute("program", {
			script: 'await repo.write({ path: "no-reason.txt", content: "blocked" });',
		}, undefined, undefined, interactiveContext(cwd, async () => { confirmations++; return true; }));
		assert.match(missingReason.content[0].text, /requires a non-empty reason/);
		const escaped = await tool.execute("program", {
			script: `await repo.write(${JSON.stringify({ path: join(outside, "escaped.txt"), content: "outside" })}, { reason: "test path boundary" });`,
		}, undefined, undefined, interactiveContext(cwd, async () => { confirmations++; return true; }));
		assert.match(escaped.content[0].text, /outside the execution repository/);
		assert.equal(confirmations, 0);
		await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(cwd, "one.txt"))), /ENOENT/);
		await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(outside, "escaped.txt"))), /ENOENT/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("an abort while an approval prompt is open prevents resume and writing", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-program-abort-approval-"));
	const controller = new AbortController();
	try {
		const tool = createPiProgramTool(() => "manual", fakePi());
		const pending = tool.execute(
			"program",
			{ script: 'await repo.write({ path: "aborted.txt", content: "blocked" }, { reason: "abort test" });' },
			controller.signal,
			undefined,
			interactiveContext(cwd, async () => {
				controller.abort();
				return new Promise<boolean>(() => undefined);
			}),
		);
		await assert.rejects(pending, /Operation aborted/);
		await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(cwd, "aborted.txt"))), /ENOENT/);
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
