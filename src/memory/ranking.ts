import type { MemoryRecord, MemorySearchResult } from "./types.js";

function terms(value: string): string[] {
	return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [])];
}

function recencyScore(record: MemoryRecord, now: number): number {
	const timestamp = Date.parse(record.lastUsedAt ?? record.updatedAt);
	if (!Number.isFinite(timestamp)) return 0;
	const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
	return Math.exp(-ageDays / 30);
}

function scoreRecord(record: MemoryRecord, queryTerms: string[], query: string, now: number): number {
	if (queryTerms.length === 0) {
		return record.importance * 0.6 + Math.min(1, record.confirmationCount / 5) * 0.3 + recencyScore(record, now) * 0.1;
	}

	const contentTerms = new Set(terms(record.content));
	const tagTerms = new Set(record.tags.flatMap(terms));
	const matchedContent = queryTerms.filter((term) => contentTerms.has(term)).length;
	const matchedTags = queryTerms.filter((term) => tagTerms.has(term)).length;
	const overlap = matchedContent / queryTerms.length;
	const tagMatch = matchedTags / queryTerms.length;
	const phraseMatch = record.content.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
	const importance = Math.max(0, Math.min(1, record.importance));
	const confirmations = Math.min(1, Math.log1p(record.confirmationCount) / Math.log(6));
	const retrievals = Math.min(1, Math.log1p(record.retrievalCount) / Math.log(21));

	return (
		overlap * 0.55 +
		tagMatch * 0.15 +
		phraseMatch * 0.1 +
		importance * 0.1 +
		confirmations * 0.07 +
		retrievals * 0.01 +
		recencyScore(record, now) * 0.02
	);
}

export function rankMemories(records: MemoryRecord[], query: string): MemorySearchResult[] {
	const queryTerms = terms(query);
	const now = Date.now();
	return records
		.map((record) => ({ ...record, score: scoreRecord(record, queryTerms, query, now) }))
		.sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));
}
