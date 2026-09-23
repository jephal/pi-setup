import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import repoSearchExtension, { createRepoSearchToolDefinition, isGlobLikeQuery, repoSearchSchema, routeRepoSearch } from "./repo-search.ts";

function context(cwd: string) {
	return { cwd, signal: undefined } as any;
}

test("routes glob-like queries to files and ordinary queries to text", () => {
	assert.equal(isGlobLikeQuery("**/*.ts"), true);
	assert.equal(isGlobLikeQuery("needle"), false);
	assert.deepEqual(routeRepoSearch({ query: "**/*.ts" }), { kind: "files", args: { pattern: "**/*.ts" } });
	assert.deepEqual(routeRepoSearch({ query: "needle", path: "src", glob: "*.ts", ignoreCase: true, literal: true, context: 2, limit: 10 }), {
		kind: "text",
		args: { pattern: "needle", path: "src", glob: "*.ts", ignoreCase: true, literal: true, context: 2, limit: 10 },
	});
});

test("explicit mode overrides auto routing and file searches discard text-only options", () => {
	assert.equal(routeRepoSearch({ query: "*.ts", mode: "text", context: 1 }).kind, "text");
	assert.deepEqual(routeRepoSearch({ query: "needle", mode: "files", ignoreCase: true, literal: true, context: 3, limit: 4 }), {
		kind: "files",
		args: { pattern: "needle", limit: 4 },
	});
});

test("uses a compact shared TypeBox schema", () => {
	assert.deepEqual(repoSearchSchema.required, ["query"]);
	assert.equal(Value.Check(repoSearchSchema, { query: "needle", mode: "text", path: "src", limit: 10 }), true);
	assert.equal(Value.Check(repoSearchSchema, { query: "needle", mode: "regex" }), false);
});

test("registers the native repo_search tool", () => {
	const definitions: Array<{ name: string }> = [];
	const fakePi = { registerTool(definition: { name: string }) { definitions.push(definition); } };
	repoSearchExtension(fakePi as unknown as ExtensionAPI);
	assert.deepEqual(definitions.map((definition) => definition.name), ["repo_search"]);
	assert.equal(createRepoSearchToolDefinition().name, "repo_search");
});

test("executes direct text and automatic file searches inside its cwd", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "repo-search-direct-"));
	try {
		await writeFile(join(cwd, "marker.txt"), "direct needle\n", "utf8");
		const definition = createRepoSearchToolDefinition();
		const text = await definition.execute("text", { query: "needle", mode: "text", path: "." }, undefined, undefined, context(cwd));
		const files = await definition.execute("files", { query: "*.txt", path: "." }, undefined, undefined, context(cwd));
		assert.match(text.content[0].text, /marker\.txt:1: direct needle/);
		assert.match(files.content[0].text, /marker\.txt/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("rejects direct searches outside the execution repository and invalid bounds", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "repo-search-boundary-"));
	const outside = await mkdtemp(join(tmpdir(), "repo-search-outside-"));
	try {
		const definition = createRepoSearchToolDefinition();
		await assert.rejects(
			definition.execute("outside", { query: "secret", path: outside }, undefined, undefined, context(cwd)),
			/outside the execution repository/,
		);
		await assert.rejects(
			definition.execute("invalid", { query: "secret", limit: -1 }, undefined, undefined, context(cwd)),
			/search limit/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
