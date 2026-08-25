import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { rankMemories } from "./ranking.js";
import type {
	MemoryCategory,
	MemoryRecord,
	MemoryScope,
	MemorySearchOptions,
	MemorySearchResult,
	MemorySource,
	MemoryUpdate,
} from "./types.js";

type Row = Record<string, unknown>;

function parseTags(value: unknown): string[] {
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
	} catch {
		return [];
	}
}

function parseSource(value: unknown): MemorySource | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed as MemorySource : undefined;
	} catch {
		return undefined;
	}
}

function toRecord(row: Row): MemoryRecord {
	return {
		id: String(row.id),
		content: String(row.content),
		scope: String(row.scope) as MemoryScope,
		category: String(row.category) as MemoryCategory,
		tags: parseTags(row.tags_json),
		importance: Number(row.importance ?? 0.5),
		alwaysInject: Number(row.always_inject ?? 0) === 1,
		retrievalCount: Number(row.retrieval_count ?? 0),
		confirmationCount: Number(row.confirmation_count ?? 0),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
		source: parseSource(row.source_json),
	};
}

function normalizeTags(tags: string[]): string[] {
	return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

export class MemoryStore {
	private readonly db: DatabaseSync;

	constructor(databasePath: string) {
		mkdirSync(dirname(databasePath), { recursive: true });
		this.db = new DatabaseSync(databasePath);
		this.db.exec("PRAGMA busy_timeout = 2500; PRAGMA journal_mode = WAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
				category TEXT NOT NULL CHECK (category IN ('preference', 'fact', 'decision', 'workflow')),
				tags_json TEXT NOT NULL DEFAULT '[]',
				importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
				always_inject INTEGER NOT NULL DEFAULT 0 CHECK (always_inject IN (0, 1)),
				retrieval_count INTEGER NOT NULL DEFAULT 0,
				confirmation_count INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_used_at TEXT,
				source_json TEXT,
				deleted_at TEXT
			);
			CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope);
			CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories(updated_at);
		`);
		try {
			this.db.exec("ALTER TABLE memories ADD COLUMN always_inject INTEGER NOT NULL DEFAULT 0");
		} catch {
			// Existing databases already have the column.
		}
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE;");
		try {
			const result = operation();
			this.db.exec("COMMIT;");
			return result;
		} catch (error) {
			try { this.db.exec("ROLLBACK;"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	get(id: string): MemoryRecord | undefined {
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
		return row ? toRecord(row) : undefined;
	}

	save(input: {
		content: string;
		scope: MemoryScope;
		category: MemoryCategory;
		tags: string[];
		importance: number;
		alwaysInject?: boolean;
		source?: MemorySource;
	}): MemoryRecord {
		const now = new Date().toISOString();
		const id = `mem_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
		this.db.prepare(`
			INSERT INTO memories
			(id, content, scope, category, tags_json, importance, always_inject, confirmation_count, created_at, updated_at, source_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
		`).run(
			id,
			input.content.trim(),
			input.scope,
			input.category,
			JSON.stringify(normalizeTags(input.tags)),
			Math.max(0, Math.min(1, input.importance)),
			input.alwaysInject ? 1 : 0,
			now,
			now,
			input.source ? JSON.stringify(input.source) : null,
		);
		return this.get(id)!;
	}

	search(query: string, options: MemorySearchOptions = {}): MemorySearchResult[] {
		const scopes = options.scopes?.length ? options.scopes : ["user", "project"];
		const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
		const placeholders = scopes.map(() => "?").join(", ");
		const rows = this.db.prepare(`
			SELECT * FROM memories
			WHERE deleted_at IS NULL AND scope IN (${placeholders})
			ORDER BY importance DESC, updated_at DESC
			LIMIT 2000
		`).all(...scopes) as Row[];
		const ranked = rankMemories(rows.map(toRecord), query).filter((result) => result.score > 0 || !query.trim()).slice(0, limit);
		if (options.recordUsage !== false && ranked.length > 0) {
			this.transaction(() => {
				const now = new Date().toISOString();
				const statement = this.db.prepare("UPDATE memories SET retrieval_count = retrieval_count + 1, last_used_at = ? WHERE id = ?");
				for (const result of ranked) statement.run(now, result.id);
			});
		}
		return ranked;
	}

	list(options: { scopes?: MemoryScope[]; limit?: number } = {}): MemoryRecord[] {
		return this.search("", { ...options, recordUsage: false });
	}

	core(options: { limit?: number; maxChars?: number } = {}): MemoryRecord[] {
		const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
		const rows = this.db.prepare(`
			SELECT * FROM memories
			WHERE deleted_at IS NULL AND scope = 'user' AND always_inject = 1
			ORDER BY importance DESC, confirmation_count DESC, updated_at DESC
			LIMIT ?
		`).all(limit) as Row[];
		const records = rows.map(toRecord);
		if (options.maxChars === undefined) return records;
		let used = 0;
		return records.filter((record) => {
			const size = record.content.length;
			if (used + size > options.maxChars!) return false;
			used += size;
			return true;
		});
	}

	update(id: string, changes: MemoryUpdate): MemoryRecord | undefined {
		const current = this.get(id);
		if (!current) return undefined;
		const next: MemoryRecord = {
			...current,
			updatedAt: new Date().toISOString(),
		};
		if (changes.content !== undefined) next.content = changes.content;
		if (changes.scope !== undefined) next.scope = changes.scope;
		if (changes.category !== undefined) next.category = changes.category;
		if (changes.tags !== undefined) next.tags = normalizeTags(changes.tags);
		if (changes.importance !== undefined) next.importance = changes.importance;
		if (changes.alwaysInject !== undefined) next.alwaysInject = changes.alwaysInject;
		this.db.prepare(`
			UPDATE memories
			SET content = ?, scope = ?, category = ?, tags_json = ?, importance = ?, always_inject = ?, updated_at = ?
			WHERE id = ? AND deleted_at IS NULL
		`).run(next.content.trim(), next.scope, next.category, JSON.stringify(next.tags), Math.max(0, Math.min(1, next.importance)), next.alwaysInject ? 1 : 0, next.updatedAt, id);
		return this.get(id);
	}

	delete(id: string): boolean {
		return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
	}

	close(): void {
		this.db.close();
	}
}
