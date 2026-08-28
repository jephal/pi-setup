import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createHerdrClient,
  extractPaneId,
  extractRootPaneId,
  extractTabId,
  HerdrError,
  isNotFound,
  parseVersion,
  supportsTabShell,
} from "./herdr-client.ts";

test("extracts Herdr tab and pane identifiers from CLI envelopes", () => {
  const envelope = {
    result: {
      tab: { tab_id: "w1:t2", workspace_id: "w1" },
      root_pane: { pane_id: "w1:p2" },
      pane: { pane_id: "w1:p2" },
    },
  };

  assert.equal(extractTabId(envelope), "w1:t2");
  assert.equal(extractRootPaneId(envelope), "w1:p2");
  assert.equal(extractPaneId(envelope), "w1:p2");
});

test("accepts supported Herdr versions and rejects older versions", () => {
  assert.deepEqual(parseVersion("herdr 0.8.0"), { major: 0, minor: 8, patch: 0 });
  assert.equal(supportsTabShell(parseVersion("herdr 0.7.5")!), true);
  assert.equal(supportsTabShell(parseVersion("herdr 0.7.4")!), false);
});

test("parses JSON commands and preserves plain-text pane output", async () => {
  const calls: string[][] = [];
  const fakePi = {
    async exec(_command: string, args: string[]) {
      calls.push(args);
      if (args[0] === "pane") return { stdout: "line one\nline two\n", stderr: "", code: 0, killed: false };
      return { stdout: '{"result":{"ok":true}}\n', stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  const client = createHerdrClient(fakePi);
  assert.deepEqual(await client.run(["tab", "get", "w1:t2"]), { ok: true });
  assert.equal(await client.runText(["pane", "read", "w1:p2"]), "line one\nline two");
  assert.deepEqual(calls, [["tab", "get", "w1:t2"], ["pane", "read", "w1:p2"]]);
});

test("recognizes Herdr pane-not-found errors for stale pane recovery", () => {
  assert.equal(isNotFound(new HerdrError("pane is gone", "pane_not_found")), true);
  assert.equal(isNotFound(new HerdrError("tab is gone", "TAB_GONE")), true);
  assert.equal(isNotFound(new HerdrError("validation failed", "VALIDATION_ERROR")), false);
});

test("normalizes Herdr CLI errors", async () => {
  const fakePi = {
    async exec() {
      return {
        stdout: "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"Tab is gone\"}}\n",
        stderr: "",
        code: 1,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI;

  await assert.rejects(
    createHerdrClient(fakePi).run(["tab", "get", "missing"]),
    (error: unknown) => error instanceof HerdrError && error.code === "NOT_FOUND" && error.message === "Tab is gone",
  );
});
