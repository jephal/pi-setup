import test from "node:test";
import assert from "node:assert/strict";
import type { HerdrClient } from "./herdr-client.ts";
import { HerdrError } from "./herdr-client.ts";
import { createPane, extractCurrentContext, runPaneCommandWithRecovery } from "./herdr-shell.ts";

function binding(paneId: string) {
  return {
    key: "w1|w1:t1|/repo",
    workspaceId: "w1",
    parentTabId: "w1:t1",
    paneId,
    cwd: "/repo",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

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
      return binding("w1:p-new");
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
      return binding("w1:p-new");
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
    runPaneCommandWithRecovery(client, binding("w1:p-old"), "bad command", async () => binding("w1:p-new")),
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
