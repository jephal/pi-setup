import test from "node:test";
import assert from "node:assert/strict";
import type { HerdrClient } from "./herdr-client.ts";
import {
  createHerdrLiveRegistry,
  formatLiveInventory,
  type HerdrContext,
} from "./herdr-shell.ts";

test("refreshes and filters the live pane inventory by current tab", async () => {
  const calls: string[][] = [];
  const client = {
    async run(args: string[]) {
      calls.push(args);
      return {
        panes: [
          {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
            foreground_cwd: "/repo",
            focused: true,
            agent: "pi",
            agent_status: "working",
          },
          {
            pane_id: "w1:p2",
            workspace_id: "w1",
            tab_id: "w1:t2",
            cwd: "/other-tab",
          },
          {
            pane_id: "w2:p1",
            workspace_id: "w2",
            tab_id: "w2:t1",
            cwd: "/other-workspace",
          },
        ],
      };
    },
    async runText() {
      return "";
    },
  } as HerdrClient;
  const context: HerdrContext = { workspaceId: "w1", parentTabId: "w1:t1" };
  const registry = createHerdrLiveRegistry(client, 10_000);

  const inventory = await registry.refresh(context, true);
  assert.deepEqual(inventory.panes.map((pane) => pane.paneId), ["w1:p1"]);
  assert.deepEqual(calls, [["pane", "list", "--workspace", "w1"]]);

  await registry.refresh(context);
  assert.equal(calls.length, 1, "a fresh inventory should be served from memory");

  assert.match(formatLiveInventory(inventory), /w1:p1 \[agent pi, working, focused\]/);
  assert.match(formatLiveInventory(inventory), /cwd: \/repo/);
});

test("coalesces concurrent live inventory refreshes", async () => {
  let resolveList!: (value: unknown) => void;
  let calls = 0;
  const client = {
    run() {
      calls += 1;
      return new Promise((resolve) => {
        resolveList = resolve;
      });
    },
    async runText() {
      return "";
    },
  } as HerdrClient;
  const context: HerdrContext = { workspaceId: "w1", parentTabId: "w1:t1" };
  const registry = createHerdrLiveRegistry(client, 10_000);

  const first = registry.refresh(context, true);
  const second = registry.refresh(context, true);
  assert.equal(calls, 1);
  resolveList({ panes: [] });
  assert.equal((await first).panes.length, 0);
  assert.equal((await second).panes.length, 0);
});
