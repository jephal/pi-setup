import type { MemoryRecord, MemorySearchResult } from "./types.js";

export function memoryTerms(value: string): string[] {
	return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [])];
}

/**
 * Automatic recall should require more than one incidental word match from a
 * long task prompt. Explicit searches remain intentionally broader.
 */
export function isMeaningfullyRelevant(record: MemoryRecord, query: string): boolean {
	const queryTerms = memoryTerms(query);
	if (queryTerms.length < 2) return false;
	const recordTerms = new Set([...memoryTerms(record.content), ...record.tags.flatMap(memoryTerms)]);
	const matches = queryTerms.filter((term) => recordTerms.has(term)).length;
	return matches >= 2 || record.content.toLowerCase().includes(query.trim().toLowerCase());
}

export function memoryAgeDays(record: MemoryRecord, now = Date.now()): number {
	const timestamp = Date.parse(record.lastUsedAt ?? record.updatedAt);
	if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
	return Math.max(0, (now - timestamp) / 86_400_000);
}

/**
 * Important memories decay more slowly, while low-importance memories need
 * recent confirmation to remain eligible for automatic recall. This keeps
 * durable preferences available without allowing an unbounded archive to stay
 * in context forever.
 */
export function memoryFreshnessWindowDays(record: MemoryRecord, baseDays: number): number {
	const importance = Math.max(0, Math.min(1, record.importance));
	return Math.max(0, baseDays) * (0.5 + importance * 1.5);
}

export function isMemoryStale(record: MemoryRecord, maxAgeDays: number, now = Date.now()): boolean {
	return memoryAgeDays(record, now) > memoryFreshnessWindowDays(record, maxAgeDays);
}

function recencyScore(record: MemoryRecord, now: number): number {
	const ageDays = memoryAgeDays(record, now);
	if (!Number.isFinite(ageDays)) return 0;
	const halfLifeDays = memoryFreshnessWindowDays(record, 30);
	return Math.exp(-ageDays / Math.max(1, halfLifeDays));
}

function scoreRecord(record: MemoryRecord, queryTerms: string[], query: string, now: number): number {
	if (queryTerms.length === 0) {
		return record.importance * 0.6 + Math.min(1, record.confirmationCount / 5) * 0.3 + recencyScore(record, now) * 0.1;
	}

	const contentTerms = new Set(memoryTerms(record.content));
	const tagTerms = new Set(record.tags.flatMap(memoryTerms));
	const matchedContent = queryTerms.filter((term) => contentTerms.has(term)).length;
	const matchedTags = queryTerms.filter((term) => tagTerms.has(term)).length;
	const overlap = matchedContent / queryTerms.length;
	const tagMatch = matchedTags / queryTerms.length;
	const phraseMatch = record.content.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
	const importance = Math.max(0, Math.min(1, record.importance));
	const confirmations = Math.min(1, Math.log1p(record.confirmationCount) / Math.log(6));
	const retrievals = Math.min(1, Math.log1p(record.retrievalCount) / Math.log(21));

	return (
		overlap * 0.52 +
		tagMatch * 0.14 +
		phraseMatch * 0.1 +
		importance * 0.12 +
		confirmations * 0.06 +
		retrievals * 0.01 +
		recencyScore(record, now) * 0.05
	);
}

export function rankMemories(records: MemoryRecord[], query: string): MemorySearchResult[] {
	const queryTerms = memoryTerms(query);
	const now = Date.now();
	return records
		.map((record) => ({ ...record, score: scoreRecord(record, queryTerms, query, now) }))
		.sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));
}
