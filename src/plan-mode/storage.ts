import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

function repositoryDirectory(identity: PlanIdentity): string {
	const repositoryKey = `${slug(identity.repository)}-${createHash("sha1").update(identity.root).digest("hex").slice(0, 8)}`;
	return join(homedir(), ".pi", "agent", "plans", repositoryKey);
}

export function planDirectory(identity: PlanIdentity): string {
	// Keep the raw branch hash to distinguish otherwise identical slugs such as
	// feature/a and feature-a. A branch bucket makes the active plan available
	// to a later session on the same branch.
	const branchKey = `${slug(identity.branch)}-${createHash("sha1").update(identity.branch).digest("hex").slice(0, 8)}`;
	return join(repositoryDirectory(identity), "branches", branchKey);
}

export function legacyPlanDirectory(identity: PlanIdentity): string {
	return join(repositoryDirectory(identity), "sessions", slug(identity.sessionId));
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, content, "utf8");
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export async function savePlan(plan: StoredPlan): Promise<string> {
	const dir = planDirectory(plan.identity);
	await mkdir(join(dir, "archive"), { recursive: true });
	await Promise.all([
		writeAtomically(join(dir, "current.md"), plan.content),
		writeAtomically(join(dir, "current.todo.jsonl"), plan.steps.map((step) => JSON.stringify(step)).join("\n") + "\n"),
	]);
	// Metadata is the authoritative, self-contained plan representation. Writing
	// it last lets readers observe either the prior complete plan or this one.
	await writeAtomically(join(dir, "current.json"), JSON.stringify(plan, null, 2));
	return join(dir, "current.md");
}

async function readPlan(dir: string): Promise<StoredPlan | undefined> {
	try {
		return JSON.parse(await readFile(join(dir, "current.json"), "utf8")) as StoredPlan;
	} catch {
		return undefined;
	}
}

export async function loadPlan(identity: PlanIdentity): Promise<StoredPlan | undefined> {
	const branchPlan = await readPlan(planDirectory(identity));
	// Read a session-scoped plan from pre-branch storage once. The next save
	// writes it to the branch bucket, completing migration without touching it.
	return branchPlan ?? readPlan(legacyPlanDirectory(identity));
}

export async function clearPlan(identity: PlanIdentity): Promise<void> {
	await Promise.all([
		rm(planDirectory(identity), { recursive: true, force: true }),
		rm(legacyPlanDirectory(identity), { recursive: true, force: true }),
	]);
}
