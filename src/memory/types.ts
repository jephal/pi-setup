export type MemoryScope = "user" | "project";
export type MemoryCategory = "preference" | "fact" | "decision" | "workflow";

export interface MemorySource {
	sessionId?: string;
	messageId?: string;
}

export interface MemoryRecord {
	id: string;
	content: string;
	scope: MemoryScope;
	category: MemoryCategory;
	tags: string[];
	importance: number;
	alwaysInject: boolean;
	retrievalCount: number;
	confirmationCount: number;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
	source?: MemorySource;
}

export interface MemorySearchResult extends MemoryRecord {
	score: number;
}

export interface MemorySearchOptions {
	scopes?: MemoryScope[];
	limit?: number;
	recordUsage?: boolean;
	/** Exclude memories older than this many days from the result. */
	maxAgeDays?: number;
}

export interface MemoryUpdate {
	content?: string;
	scope?: MemoryScope;
	category?: MemoryCategory;
	tags?: string[];
	importance?: number;
	alwaysInject?: boolean;
}
