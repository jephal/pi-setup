import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PlanIdentity {
	repository: string;
	branch: string;
	worktree: string;
	root: string;
	sessionId: string;
}

export interface PlanStep {
	id: number;
	title: string;
	status: string;
}

export interface PlanExecution {
	active: boolean;
	startedAt?: string;
	completedAt?: string;
}

export interface StoredPlan {
	name: string;
	content: string;
	steps: PlanStep[];
	identity: PlanIdentity;
	updatedAt: string;
	execution?: PlanExecution;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
}

export function planDirectory(identity: PlanIdentity): string {
	const repositoryKey = `${slug(identity.repository)}-${createHash("sha1").update(identity.root).digest("hex").slice(0, 8)}`;
	return join(homedir(), ".pi", "agent", "plans", repositoryKey, "sessions", slug(identity.sessionId));
}

export async function savePlan(plan: StoredPlan): Promise<string> {
	const dir = planDirectory(plan.identity);
	await mkdir(join(dir, "archive"), { recursive: true });
	await writeFile(join(dir, "current.md"), plan.content, "utf8");
	await writeFile(join(dir, "current.json"), JSON.stringify(plan, null, 2), "utf8");
	await writeFile(join(dir, "current.todo.jsonl"), plan.steps.map((step) => JSON.stringify(step)).join("\n") + "\n", "utf8");
	return join(dir, "current.md");
}

export async function loadPlan(identity: PlanIdentity): Promise<StoredPlan | undefined> {
	const dir = planDirectory(identity);
	try {
		const [content, metadata] = await Promise.all([
			readFile(join(dir, "current.md"), "utf8"),
			readFile(join(dir, "current.json"), "utf8"),
		]);
		const parsed = JSON.parse(metadata) as StoredPlan;
		return { ...parsed, content };
	} catch {
		return undefined;
	}
}

export async function clearPlan(identity: PlanIdentity): Promise<void> {
	await rm(planDirectory(identity), { recursive: true, force: true });
}
