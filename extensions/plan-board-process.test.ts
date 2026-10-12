import assert from "node:assert/strict";
import test from "node:test";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createPlanBoardEndpoint, planBoardCommand, runPlanBoard, sendPlanBoardCommand, waitForPlanBoardSocket, PLAN_BOARD_MAX_CONTROL_FRAME_BYTES } from "./plan-board-process.ts";

const entry = fileURLToPath(new URL("./plan-board-process.ts", import.meta.url));
const snapshot = { version: 1 as const, title: "Board", status: "active" as const, identity: { name: "Board", repository: "repo", branch: "main", root: "/repo", sessionId: "s" }, lines: ["# Board", "Status: active"] };

test("uses a fixed command and private endpoint", async () => {
  const endpoint = await createPlanBoardEndpoint();
  try {
    assert.match(planBoardCommand(endpoint.socket, entry), /--experimental-strip-types/);
    assert.equal((await stat(endpoint.directory)).mode & 0o777, 0o700);
  } finally { await endpoint.cleanup(); }
});

test("supports bounded revision snapshots, redraw, and close over a private socket", async () => {
  const endpoint = await createPlanBoardEndpoint();
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--socket", endpoint.socket], { stdio: "ignore" });
  try {
    await waitForPlanBoardSocket(endpoint.socket);
    assert.equal((await stat(endpoint.socket)).mode & 0o777, 0o600);
    assert.equal((await sendPlanBoardCommand(endpoint.socket, { op: "set_snapshot", revision: 1, snapshot })).revision, 1);
    await assert.rejects(sendPlanBoardCommand(endpoint.socket, { op: "set_snapshot", revision: 1, snapshot }), /initial revision/);
    await assert.rejects(sendPlanBoardCommand(endpoint.socket, { op: "update", revision: 0, snapshot }), /stale Plan Board revision/);
    const updated = await sendPlanBoardCommand(endpoint.socket, { op: "update", revision: 1, snapshot: { ...snapshot, lines: ["updated"] } });
    assert.equal(updated.revision, 2);
    const current = await sendPlanBoardCommand(endpoint.socket, { op: "get" });
    assert.deepEqual(current.snapshot?.lines, ["updated"]);
    assert.equal((await sendPlanBoardCommand(endpoint.socket, { op: "redraw" })).ok, true);
    await sendPlanBoardCommand(endpoint.socket, { op: "close" });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await endpoint.cleanup();
  }
});

test("closes a connection that floods multiple control frames", async () => {
  const endpoint = await createPlanBoardEndpoint();
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--socket", endpoint.socket], { stdio: "ignore" });
  try {
    await waitForPlanBoardSocket(endpoint.socket);
    const attacker = net.createConnection({ path: endpoint.socket });
    await new Promise<void>((resolve, reject) => { attacker.once("connect", () => resolve()); attacker.once("error", reject); });
    const closed = new Promise<void>((resolve) => attacker.once("close", () => resolve()));
    attacker.write('{"op":"ping"}\n{"op":"ping"}\n');
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("flooding connection remained open")), 1_000))]);
    attacker.destroy();
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await endpoint.cleanup();
  }
});

test("cleans up raw mode and alternate screen for interactive quit", async () => {
  const endpoint = await createPlanBoardEndpoint();
  const input = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode: (value: boolean) => void; resume: () => void; pause: () => void };
  input.isTTY = true;
  const rawModes: boolean[] = [];
  input.setRawMode = (value) => rawModes.push(value);
  input.resume = () => undefined; input.pause = () => undefined;
  const writes: string[] = [];
  const output = { isTTY: true, columns: 40, rows: 12, write(value: string) { writes.push(value); return true; } };
  const running = runPlanBoard({ socket: endpoint.socket, stdin: input as any, stdout: output as any });
  try {
    await waitForPlanBoardSocket(endpoint.socket);
    await sendPlanBoardCommand(endpoint.socket, { op: "set_snapshot", revision: 1, snapshot });
    input.emit("data", Buffer.from("q"));
    await running;
    assert.deepEqual(rawModes, [true, false]);
    assert.ok(writes.some((value) => value.includes("\u001b[?1049h")));
    assert.ok(writes.some((value) => value.includes("\u001b[?1000h") && value.includes("\u001b[?1006h")));
    assert.ok(writes.some((value) => value.includes("\u001b[?1006l") && value.includes("\u001b[?1000l")));
    assert.ok(writes.some((value) => value.includes("\u001b[?1049l")));
  } finally { await endpoint.cleanup(); }
});

test("renders the bounded Markdown projection through Pi's shared component", async () => {
  const endpoint = await createPlanBoardEndpoint();
  const input = Object.assign(new EventEmitter(), { isTTY: false, pause: () => undefined });
  const writes: string[] = [];
  const output = { isTTY: false, columns: 64, rows: 24, write(value: string) { writes.push(value); return true; } };
  const running = runPlanBoard({ socket: endpoint.socket, stdin: input as any, stdout: output as any });
  const markdownSnapshot = {
    ...snapshot,
    markdown: "# Shared heading\n\nUse **bold** and *italic*.\n\n- item\n- [x] checked\n\n```ts\nconst code = true;\n```",
    lines: ["PLAIN FALLBACK"],
  };
  try {
    await waitForPlanBoardSocket(endpoint.socket);
    await sendPlanBoardCommand(endpoint.socket, { op: "set_snapshot", revision: 1, snapshot: markdownSnapshot });
    const text = stripTerminalSequences(writes.join(""));
    assert.match(text, /Shared heading/);
    assert.match(text, /bold/);
    assert.match(text, /italic/);
    assert.match(text, /item/);
    assert.match(text, /checked/);
    assert.match(text, /const code = true/);
    assert.doesNotMatch(text, /PLAIN FALLBACK/);
    await sendPlanBoardCommand(endpoint.socket, { op: "close" });
    await running;
  } finally {
    await sendPlanBoardCommand(endpoint.socket, { op: "close" }).catch(() => undefined);
    await running.catch(() => undefined);
    await endpoint.cleanup();
  }
});

test("standalone child initializes Pi's theme before rendering Markdown", async () => {
  const endpoint = await createPlanBoardEndpoint();
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--socket", endpoint.socket], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  const rendered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("standalone Plan Board did not render Markdown")), 3_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (stripTerminalSequences(output).includes("Child process heading")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("standalone Plan Board exited before rendering Markdown")); });
  });
  try {
    await waitForPlanBoardSocket(endpoint.socket);
    await sendPlanBoardCommand(endpoint.socket, {
      op: "set_snapshot", revision: 1,
      snapshot: { ...snapshot, markdown: "# Child process heading\n\nShared **Markdown**", lines: ["PLAIN FALLBACK"] },
    });
    await rendered;
    assert.match(stripTerminalSequences(output), /Child process heading/);
    assert.doesNotMatch(stripTerminalSequences(output), /PLAIN FALLBACK/);
    await sendPlanBoardCommand(endpoint.socket, { op: "close" });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await endpoint.cleanup();
  }
});

test("rejects oversized command frames before connecting", async () => {
  const endpoint = await createPlanBoardEndpoint();
  try { await assert.rejects(sendPlanBoardCommand(endpoint.socket, { op: "ping", requestId: "x".repeat(PLAN_BOARD_MAX_CONTROL_FRAME_BYTES) }), /frame is too large/); }
  finally { await endpoint.cleanup(); }
});
