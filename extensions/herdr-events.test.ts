import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_SUBSCRIPTION_TYPES, HerdrEventSubscriber, parseHerdrEventLine, parseHerdrSubscriptionMessage, resolveHerdrSocketPath } from "./herdr-events.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("uses dotted subscription requests but normalizes recorded snake_case event envelopes", () => {
  assert.deepEqual(HERDR_SUBSCRIPTION_TYPES, ["pane.closed", "pane.exited", "pane.moved", "tab.closed", "workspace.closed"]);
  // Recorded from a real Herdr event stream: request types and envelope names differ.
  const recorded = '{"event":"pane_closed","data":{"pane_id":"ws:pane-7","workspace_id":"ws","tab_id":"ws:tab-1"}}';
  assert.deepEqual(parseHerdrEventLine(recorded), { event: "pane.closed", data: { pane_id: "ws:pane-7", workspace_id: "ws", tab_id: "ws:tab-1" } });
  assert.equal(parseHerdrEventLine('{"event":"pane.closed","data":{"pane_id":"w:p"}}'), undefined);
  assert.deepEqual(parseHerdrSubscriptionMessage('{"id":"sub","result":{"type":"subscription_started"}}'), { kind: "acknowledged" });
  assert.deepEqual(parseHerdrSubscriptionMessage('{"id":"sub","error":{"message":"denied"}}'), { kind: "error", error: "denied" });
  assert.equal(parseHerdrEventLine('{"event":"pane_updated","data":{}}'), undefined);
  assert.equal(resolveHerdrSocketPath({ XDG_CONFIG_HOME: "/config", HERDR_SESSION: "work" }), "/config/herdr/sessions/work/herdr.sock");
});

test("subscribes over NDJSON, reconnects after a close, and stops cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-events-"));
  const socketPath = join(directory, "herdr.sock");
  let connections = 0;
  const events: string[] = [];
  const server = net.createServer((socket) => {
    connections += 1;
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString()) as { method: string; params: { subscriptions: Array<{ type: string }> } };
      assert.equal(request.method, "events.subscribe");
      assert.deepEqual(request.params.subscriptions.map(({ type }) => type), HERDR_SUBSCRIPTION_TYPES);
      if (connections === 1) {
        socket.write('{"id":"sub","result":{"type":"subscription_started"}}\n');
        socket.write('{"event":"pane_exited","data":{"pane_id":"w:p"}}\n');
        socket.end();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => server.listen(socketPath, () => resolve()).once("error", reject));
    const subscriber = new HerdrEventSubscriber({ socketPath, reconnectMs: 20, onEvent: (event) => events.push(event.event) });
    subscriber.start();
    for (let attempt = 0; attempt < 30 && (events.length !== 1 || connections < 2); attempt += 1) await delay(20);
    assert.deepEqual(events, ["pane.exited"]);
    assert.ok(connections >= 2);
    subscriber.close();
    const stoppedAt = connections;
    await delay(80);
    assert.equal(connections, stoppedAt);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
