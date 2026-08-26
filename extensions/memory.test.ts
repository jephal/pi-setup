import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/db.ts";
import { memoryFreshnessWindowDays } from "../src/memory/ranking.ts";

test("importance controls the automatic freshness window", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-"));
	const databasePath = join(root, "memory.sqlite");
	const store = new MemoryStore(databasePath);
	const low = store.save({
		content: "Low importance temporary preference",
		scope: "user",
		category: "preference",
		tags: [],
		importance: 0.1,
	});
	const high = store.save({
		content: "High importance durable preference",
		scope: "user",
		category: "preference",
		tags: [],
		importance: 0.9,
	});
	store.close();

	const oldDate = new Date(Date.now() - 220 * 86_400_000).toISOString();
	const db = new DatabaseSync(databasePath);
	db.prepare("UPDATE memories SET updated_at = ?, last_used_at = NULL").run(oldDate);
	db.close();

	const reopened = new MemoryStore(databasePath);
	try {
		const recalled = reopened.search("preference", {
			scopes: ["user"],
			maxAgeDays: 180,
			recordUsage: false,
		});
		assert.deepEqual(recalled.map((record) => record.id), [high.id]);
		assert.ok(memoryFreshnessWindowDays(high, 180) > memoryFreshnessWindowDays(low, 180));
	} finally {
		reopened.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("core memories also exclude stale records", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-core-"));
	const databasePath = join(root, "memory.sqlite");
	const store = new MemoryStore(databasePath);
	const stale = store.save({
		content: "Old core preference",
		scope: "user",
		category: "preference",
		tags: [],
		importance: 0.9,
		alwaysInject: true,
	});
	const fresh = store.save({
		content: "Current core preference",
		scope: "user",
		category: "preference",
		tags: [],
		importance: 0.9,
		alwaysInject: true,
	});
	store.close();

	const oldDate = new Date(Date.now() - 400 * 86_400_000).toISOString();
	const db = new DatabaseSync(databasePath);
	db.prepare("UPDATE memories SET updated_at = ?, last_used_at = NULL WHERE id = ?").run(oldDate, stale.id);
	db.close();

	const reopened = new MemoryStore(databasePath);
	try {
		const core = reopened.core({ maxAgeDays: 180 });
		assert.deepEqual(core.map((record) => record.id), [fresh.id]);
	} finally {
		reopened.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("saving the same confirmed memory refreshes it instead of duplicating it", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-dedupe-"));
	const databasePath = join(root, "memory.sqlite");
	const store = new MemoryStore(databasePath);
	try {
		const first = store.save({
			content: "Use concise explanations",
			scope: "user",
			category: "preference",
			tags: ["style"],
			importance: 0.7,
		});
		const second = store.save({
			content: "  use concise explanations  ",
			scope: "user",
			category: "preference",
			tags: ["style", "confirmed"],
			importance: 0.9,
			alwaysInject: true,
		});
		assert.equal(second.id, first.id);
		assert.equal(second.confirmationCount, 2);
		assert.equal(second.importance, 0.9);
		assert.equal(second.alwaysInject, true);
		assert.deepEqual(second.tags, ["style", "confirmed"]);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});
