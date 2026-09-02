import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrClient } from "./herdr-client.ts";
import { HerdrError } from "./herdr-client.ts";
import herdrShellExtension, { createPane, discoveredNotesBinding, extractCurrentContext, getHerdrContext, getPaneProcessInfo, hasLostGenericShellOwnership, isShellForeground, reconcileLivePaneSnapshot, runPaneCommandWithRecovery } from "./herdr-shell.ts";

function binding(paneId: string, role: "generic-shell" | "notes-viewer" = "generic-shell") {
  return {
    key: "w1|w1:t1|/repo",
    role,
    workspaceId: "w1",
    parentTabId: "w1:t1",
    paneId,
    cwd: "/repo",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

test("rejects untyped internal Herdr command requests without creating a command channel", () => {
  let handler: ((value: unknown) => void) | undefined;
  const fakePi = {
    on() {},
    registerTool() {},
    events: { on(name: string, callback: (value: unknown) => void) { if (name === "herdr:open-command") handler = callback; } },
  } as unknown as ExtensionAPI;
  herdrShellExtension(fakePi);
  let result: { ok: boolean; error?: string } | undefined;
  handler?.({ command: "echo unsafe", cwd: "/repo", respond: (value: { ok: boolean; error?: string }) => { result = value; } });
  assert.deepEqual(result, { ok: false, error: "herdr:open-command accepts only typed Notes viewer requests." });
});

test("uses only the live current-pane response rather than inherited environment IDs", async () => {
  const previous = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "stale-pane";
  try {
    const client = {
      async run(args: string[]) {
        assert.deepEqual(args, ["pane", "current", "--current"]);
        return { pane: { pane_id: "live-pane", tab_id: "w1:t2", workspace_id: "w1" } };
      },
      async runText() { return ""; },
    } as HerdrClient;
    assert.deepEqual(await getHerdrContext(client), { workspaceId: "w1", parentTabId: "w1:t2", paneId: "live-pane" });
  } finally {
    if (previous === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previous;
  }
});

test("uses installed --pane argv for every process-info lookup", async () => {
  const calls: string[][] = [];
  const client = {
    async run(args: string[]) { calls.push(args); return { shell_pid: 42, foreground_processes: [{ pid: 42 }] }; },
    async runText() { return ""; },
  } as HerdrClient;
  await getPaneProcessInfo(client, "w1:p1");
  assert.deepEqual(calls, [["pane", "process-info", "--pane", "w1:p1"]]);
});

test("fails closed when the current context does not identify a tab", () => {
  assert.equal(extractCurrentContext({ pane: { pane_id: "w1:p1", workspace_id: "w1" } }), undefined);
});

test("accepts only the pane shell as a safe foreground command target", () => {
  assert.equal(isShellForeground({ shell_pid: 42, foreground_processes: [{ pid: 42, name: "bash" }] }), true);
  assert.equal(isShellForeground({ shell_pid: 42, foreground_processes: [{ pid: 99, name: "nvim" }] }), false);
  assert.equal(isShellForeground({ foreground_processes: [] }), false);
});

test("recreates a missing pane, retries once, and forwards the abort signal", async () => {
  const calls: { args: string[]; signal: AbortSignal | undefined }[] = [];
  const controller = new AbortController();
  let recreateCalls = 0;
  const client = {
    async run(args: string[], options?: { signal?: AbortSignal }) {
      calls.push({ args, signal: options?.signal });
      if (args[2] === "w1:p-old") {
        throw new HerdrError("pane w1:p-old not found", "pane_not_found");
      }
      return { ok: true };
    },
    async runText() {
      return "";
    },
  } as HerdrClient;

  const result = await runPaneCommandWithRecovery(
    client,
    binding("w1:p-old"),
    "npm run dev",
    async () => {
      recreateCalls += 1;
      return { binding: binding("w1:p-new"), created: true };
    },
    controller.signal,
  );

  assert.equal(result.paneId, "w1:p-new");
  assert.equal(recreateCalls, 1);
  assert.deepEqual(calls.map(({ args }) => args), [
    ["pane", "run", "w1:p-old", "npm run dev"],
    ["pane", "run", "w1:p-new", "npm run dev"],
  ]);
  assert.deepEqual(calls.map(({ signal }) => signal), [controller.signal, controller.signal]);
});

test("does not send a command when the final foreground guard reports a non-shell process", async () => {
  let ran = false;
  const client = {
    async run() { ran = true; return {}; },
    async runText() { return ""; },
  } as HerdrClient;
  await assert.rejects(runPaneCommandWithRecovery(client, binding("w1:p1"), "echo unsafe", async () => ({ binding: binding("w1:p2"), created: false }), undefined, async () => false), /non-shell foreground/);
  assert.equal(ran, false);
});

test("does not clean up an adopted replacement after its retry fails", async () => {
  const client = {
    async run() { throw new HerdrError("pane missing", "PANE_NOT_FOUND"); },
    async runText() { return ""; },
  } as HerdrClient;
  let discarded = 0;
  await assert.rejects(runPaneCommandWithRecovery(
    client,
    binding("w1:p-old"),
    "npm run dev",
    async () => ({ binding: binding("w1:p-adopted"), created: false }),
    undefined,
    undefined,
    async () => { discarded += 1; },
  ));
  assert.equal(discarded, 0);
});

test("records the actual Herdr cwd when discovering a Notes viewer", () => {
  const viewer = discoveredNotesBinding("notes-viewer|/notes", "/notes", {
    pane_id: "w1:p-notes", workspace_id: "w1", tab_id: "w1:t2", terminal_id: "term-notes", cwd: "/other-project",
  }, "w1:p-notes");
  assert.equal(viewer.cwd, "/other-project");
});

test("treats a changed generic terminal as lost ownership but permits Notes Nvim recovery", () => {
  const shell = { ...binding("w1:p1"), terminalId: "term-old" };
  const restarted = { pane: {}, terminalId: "term-new", shellReady: true };
  assert.equal(hasLostGenericShellOwnership(shell, restarted), true);
  assert.equal(hasLostGenericShellOwnership({ ...shell, role: "notes-viewer" }, restarted), false);
});

test("snapshot reconciliation preserves a binding written after the pane list and supports unscoped tabs", () => {
  const afterSnapshot = new Map([["new", { ...binding("new"), updatedAt: new Date(10_001).toISOString() }]]);
  reconcileLivePaneSnapshot(afterSnapshot, new Map(), 10_000);
  assert.ok(afterSnapshot.has("new"));

  const oldUnscoped = { ...binding("old"), parentTabId: undefined, updatedAt: new Date(1).toISOString() };
  const records = new Map([["old", oldUnscoped]]);
  reconcileLivePaneSnapshot(records, new Map([[oldUnscoped.paneId, { workspace_id: "w1", cwd: "/repo" }]]), 10_000);
  assert.ok(records.has("old"));
});

test("reconciliation retains generic terminal ownership fences but refreshes Notes terminal identity", () => {
  const generic = { ...binding("shell"), terminalId: "term-before", updatedAt: new Date(1).toISOString() };
  const notes = { ...binding("notes", "notes-viewer"), terminalId: "term-before", updatedAt: new Date(1).toISOString() };
  const records = new Map([["shell", generic], ["notes", notes]]);
  const live = new Map([
    [generic.paneId, { workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", terminal_id: "term-after" }],
    [notes.paneId, { workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", terminal_id: "term-after" }],
  ]);
  reconcileLivePaneSnapshot(records, live, 10_000);
  assert.equal(records.get("shell")?.terminalId, "term-before");
  assert.equal(records.get("notes")?.terminalId, "term-after");
});

test("does not recreate a pane for unrelated command errors", async () => {
  let recreateCalls = 0;
  const client = {
    async run() {
      throw new HerdrError("command rejected", "VALIDATION_ERROR");
    },
    async runText() {
      return "";
    },
  } as HerdrClient;

  await assert.rejects(
    runPaneCommandWithRecovery(client, binding("w1:p1"), "bad command", async () => {
      recreateCalls += 1;
      return { binding: binding("w1:p-new"), created: true };
    }),
    (error: unknown) => error instanceof HerdrError && error.code === "VALIDATION_ERROR",
  );
  assert.equal(recreateCalls, 0);
});

test("retains stale-pane and retry failures when recovery cannot run the command", async () => {
  const stalePaneError = new HerdrError("pane w1:p-old not found", "PANE_NOT_FOUND");
  const retryError = new HerdrError("command rejected", "VALIDATION_ERROR");
  const client = {
    async run(args: string[]) {
      if (args[2] === "w1:p-old") throw stalePaneError;
      throw retryError;
    },
    async runText() {
      return "";
    },
  } as HerdrClient;

  await assert.rejects(
    runPaneCommandWithRecovery(client, binding("w1:p-old"), "bad command", async () => ({ binding: binding("w1:p-new"), created: true })),
    (error: unknown) => error instanceof AggregateError &&
      error.message.includes("replacement pane w1:p-new") &&
      error.errors[0] === stalePaneError &&
      error.errors[1] === retryError,
  );
});

test("retries a split with the current pane when the caller pane is stale", async () => {
  const calls: string[][] = [];
  const client = {
    async run(args: string[]) {
      calls.push(args);
      if (args.includes("--pane")) throw new HerdrError("caller pane is gone", "pane_not_found");
      return { pane: { pane_id: "w1:p-new" } };
    },
    async runText() {
      return "";
    },
  } as HerdrClient;

  const created = await createPane(client, { workspaceId: "w1", paneId: "w1:p-gone" }, "/repo");
  assert.equal(created.paneId, "w1:p-new");
  assert.deepEqual(calls.map((args) => args.slice(0, 4)), [
    ["pane", "split", "--pane", "w1:p-gone"],
    ["pane", "split", "--current", "--direction"],
  ]);
});

test("uses the caller pane for splits and falls back to the current pane", async () => {
  const calls: string[][] = [];
  const client = {
    async run(args: string[]) {
      calls.push(args);
      return { pane: { pane_id: "w1:p-new" } };
    },
    async runText() {
      return "";
    },
  } as HerdrClient;

  const context = extractCurrentContext({
    result: { pane: { pane_id: "w1:p-caller", tab_id: "w1:t1", workspace_id: "w1" } },
  });
  assert.deepEqual(context, { workspaceId: "w1", parentTabId: "w1:t1", paneId: "w1:p-caller" });

  await createPane(client, context!, "/repo");
  await createPane(client, { workspaceId: "w1" }, "/repo");
  assert.deepEqual(calls, [
    ["pane", "split", "--pane", "w1:p-caller", "--direction", "right", "--cwd", "/repo", "--no-focus"],
    ["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--no-focus"],
  ]);
});
