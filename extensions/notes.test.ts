import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureFrontmatter } from "../src/notes/frontmatter.ts";
import { NotesVault } from "../src/notes/vault.ts";
import notesExtension from "./notes.ts";

test("registers the agent-first Notes tool surface", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const fakePi = {
		registerTool(definition: { name: string }) {
			tools.push(definition.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	};

	notesExtension(fakePi as unknown as ExtensionAPI);
	assert.deepEqual(tools, ["notes_list", "notes_search", "notes_read", "notes_write", "notes_transfer", "notes_open_viewer", "notes_open_note", "notes_refresh", "notes_save", "notes_git"]);
	assert.deepEqual(commands, ["notes", "notes-open"]);
});

async function makeVault(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-notes-"));
	await mkdir(join(root, ".notes"));
	await mkdir(join(root, "Projects"));
	await mkdir(join(root, ".hidden"));
	await writeFile(join(root, "Welcome.md"), "# Welcome\nThis is the home note.\n");
	await writeFile(join(root, "Projects", "Pi.md"), "# Pi\nAgent-first tooling for pi.\n");
	await writeFile(join(root, ".hidden", "Secret.md"), "hidden note");
	return root;
}

test("returns a direct VM command when Herdr is unavailable", async () => {
	const root = await makeVault();
	const previousVault = process.env.NOTES_PATH;
	try {
		process.env.NOTES_PATH = root;
		const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
		const fakePi = {
			registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) {
				definitions.push(definition);
			},
			registerCommand() {},
			getAllTools() {
				return [];
			},
			events: { emit() {} },
		};
		notesExtension(fakePi as unknown as ExtensionAPI);
		const tool = definitions.find((definition) => definition.name === "notes_open_viewer");
		assert.ok(tool);
		const result = await tool.execute("test", { readOnly: true });
		assert.equal(result.details.opened, false);
		assert.match(result.content[0].text, /src\/notes\/nvim-init\.lua/);
		assert.match(result.content[0].text, /--listen/);
		assert.match(result.content[0].text, /--clean/);
	} finally {
		if (previousVault === undefined) delete process.env.NOTES_PATH;
		else process.env.NOTES_PATH = previousVault;
		await rm(root, { recursive: true, force: true });
	}
});

test("adds a stable YAML header when note content has no frontmatter", () => {
	const result = ensureFrontmatter("Body\n", "agents/example.md", new Date(2026, 7, 26));
	assert.equal(result.added, true);
	assert.match(result.content, /^---\ntitle: "example"\ntype: note\nstatus: active\ncreated: 2026-08-26\nupdated: 2026-08-26\ntags: \[\]\n---\nBody/);
});

test("preserves existing metadata while refreshing updated date", () => {
	const result = ensureFrontmatter("---\ntitle: Custom\ncreated: 2026-01-01\ntags:\n  - work\n---\nBody\n", "example.md", new Date(2026, 7, 26));
	assert.equal(result.added, false);
	assert.match(result.content, /title: Custom/);
	assert.match(result.content, /created: 2026-01-01/);
	assert.match(result.content, /updated: 2026-08-26/);
	assert.match(result.content, /tags:\n  - work/);
	assert.match(result.content, /type: note/);
	assert.match(result.content, /status: active/);
});

test("lists Markdown notes while excluding hidden directories", async () => {
	const root = await makeVault();
	try {
		const notes = await new NotesVault(root).listNotes();
		assert.deepEqual(notes.map((note) => note.path), ["Projects/Pi.md", "Welcome.md"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("searches note content and filenames", async () => {
	const root = await makeVault();
	try {
		const vault = new NotesVault(root);
		const contentMatches = await vault.search("agent-first");
		assert.deepEqual(contentMatches.map((match) => [match.path, match.line]), [["Projects/Pi.md", 2]]);

		const filenameMatches = await vault.search("welcome");
		assert.deepEqual(filenameMatches, [{ path: "Welcome.md", snippet: "# Welcome", line: 1 }]);

		const pathMatches = await vault.search("Projects");
		assert.deepEqual(pathMatches, [{ path: "Projects/Pi.md", snippet: "Filename match" }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("times out an expensive regex in isolation", async () => {
	const root = await makeVault();
	try {
		await writeFile(join(root, "Regex.md"), `${"a".repeat(64)}b\n`);
		const vault = new NotesVault(root);
		const started = Date.now();
		await assert.rejects(vault.search("(a+)+$", ".", 20, { mode: "regex" }), /exceeded 250ms/);
		assert.ok(Date.now() - started < 2_000);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("supports regex, globs, case sensitivity, context, and path-only search", async () => {
	const root = await makeVault();
	try {
		const vault = new NotesVault(root);
		const regexMatches = await vault.search("agent-first|home", ".", 20, { mode: "regex", contextLines: 1 });
		assert.deepEqual(regexMatches.map((match) => [match.path, match.line]), [["Projects/Pi.md", 2], ["Welcome.md", 2]]);
		assert.match(regexMatches[0].snippet!, /# Pi\nAgent-first tooling/);

		const scopedMatches = await vault.search("agent", "Projects", 20, { glob: "./*.md", pathsOnly: true });
		assert.deepEqual(scopedMatches, [{ path: "Projects/Pi.md", snippet: "Path match" }]);

		const filenameMatches = await vault.search("WELCOME", ".", 20, { mode: "filename", pathsOnly: true });
		assert.deepEqual(filenameMatches, [{ path: "Welcome.md", snippet: "Path match" }]);
		assert.deepEqual(await vault.search("WELCOME", ".", 20, { caseSensitive: true }), []);
		await assert.rejects(vault.search("[", ".", 20, { mode: "regex" }), /Invalid Notes search regular expression/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("copies and moves notes without changing their content", async () => {
	const root = await makeVault();
	try {
		const vault = new NotesVault(root);
		const original = (await vault.readNote("Welcome.md")).content;

		const copied = await vault.transferNote("Welcome.md", "Archive/Copied.md", "copy");
		assert.deepEqual(copied, { action: "copy", source: "Welcome.md", destination: "Archive/Copied.md", bytes: Buffer.byteLength(original, "utf8") });
		assert.equal((await vault.readNote("Welcome.md")).content, original);
		assert.equal((await vault.readNote("Archive/Copied.md")).content, original);

		const moved = await vault.transferNote("Archive/Copied.md", "Archive/Moved.md", "move");
		assert.equal(moved.destination, "Archive/Moved.md");
		assert.equal((await vault.readNote("Archive/Moved.md")).content, original);
		await assert.rejects(vault.readNote("Archive/Copied.md"), /not found/);
		await assert.rejects(vault.transferNote("Welcome.md", "Archive/Moved.md", "copy"), /already exists/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reads notes and supports explicit create, append, and overwrite modes", async () => {
	const root = await makeVault();
	try {
		const vault = new NotesVault(root);
		const created = await vault.writeNote("Daily/Today.md", "# Today\n", "create");
		assert.equal(created.path, "Daily/Today.md");
		await vault.writeNote("Daily/Today.md", "A useful note.\n", "append");
		const appended = (await vault.readNote("Daily/Today.md")).content;
		assert.match(appended, /title: "Today"/);
		assert.match(appended, /# Today\nA useful note\./);
		await vault.writeNote("Daily/Today.md", "# Replaced\n", "overwrite");
		const overwritten = (await vault.readNote("Daily/Today.md")).content;
		assert.match(overwritten, /title: "Today"/);
		assert.match(overwritten, /# Replaced/);

		await assert.rejects(vault.writeNote("Daily/Today.md", "again", "create"), /already exists/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects traversal and symlink access", async () => {
	const root = await makeVault();
	const outside = await mkdtemp(join(tmpdir(), "pi-notes-outside-"));
	try {
		await writeFile(join(outside, "Outside.md"), "outside");
		await symlink(join(outside, "Outside.md"), join(root, "Linked.md"));
		const vault = new NotesVault(root);
		await assert.rejects(vault.readNote("Linked.md"), /symlink/);
		await assert.rejects(vault.transferNote("Linked.md", "Copy.md", "copy"), /symlink/);
		await assert.rejects(vault.listNotes(".hidden"), /hidden paths/);
		await assert.rejects(vault.readNote("../Outside.md"), /cannot contain '\.\.'/);
		await assert.rejects(vault.writeNote("../Outside.md", "escape", "create"), /cannot contain '\.\.'/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
