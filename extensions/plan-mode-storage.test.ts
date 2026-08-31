import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { legacyPlanDirectory, loadPlan, planDirectory, savePlan, type PlanIdentity } from "../src/plan-mode/storage.ts";

const identity = (branch: string, sessionId: string): PlanIdentity => ({
  repository: "pi-setup",
  branch,
  worktree: "/work/pi-setup",
  root: "/work/pi-setup",
  sessionId,
});

test("plan storage is shared by sessions on a branch and isolated by raw branch name", () => {
  const mainSessionOne = planDirectory(identity("main", "session-one"));
  const mainSessionTwo = planDirectory(identity("main", "session-two"));
  const slashBranch = planDirectory(identity("feature/a", "session-one"));
  const dashBranch = planDirectory(identity("feature-a", "session-one"));

  assert.equal(mainSessionOne, mainSessionTwo);
  assert.match(mainSessionOne, /\/branches\/main-[a-f0-9]{8}$/);
  assert.notEqual(slashBranch, dashBranch);
});

test("loads a session-scoped legacy plan until it is migrated by the next save", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-plan-storage-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const planIdentity = identity("main", "legacy-session");
  const legacyDir = legacyPlanDirectory(planIdentity);
  const metadata = {
    name: "legacy plan",
    content: "stale metadata content",
    steps: [],
    identity: planIdentity,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    await mkdir(legacyDir, { recursive: true });
    await Promise.all([
      writeFile(join(legacyDir, "current.md"), "# Legacy plan\n", "utf8"),
      writeFile(join(legacyDir, "current.json"), JSON.stringify(metadata), "utf8"),
    ]);
    assert.deepEqual(await loadPlan(planIdentity), metadata);
    await savePlan({ ...metadata, content: "# Migrated plan\n" });
    assert.deepEqual(await loadPlan(planIdentity), { ...metadata, content: "# Migrated plan\n" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
