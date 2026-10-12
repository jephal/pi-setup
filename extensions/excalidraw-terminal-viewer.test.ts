import assert from "node:assert/strict";
import test from "node:test";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createTerminalViewerEndpoint, runTerminalViewer, sendTerminalViewerCommand, terminalViewerCommand, waitForTerminalViewerSocket, MAX_CONTROL_BUFFER_BYTES, MAX_CONTROL_FRAME_BYTES } from "./excalidraw-terminal-viewer.ts";

const entry = fileURLToPath(new URL("./excalidraw-terminal-viewer.ts", import.meta.url));
const scene = { type: "excalidraw", elements: [{ type: "rectangle", x: 0, y: 0, width: 80, height: 40, text: "API" }], appState: {}, files: {} };

test("uses a fixed executable and safely quoted private socket argument", async () => {
  const endpoint = await createTerminalViewerEndpoint();
  try {
    assert.match(terminalViewerCommand(endpoint.socket, entry), /--experimental-strip-types/);
    assert.match(terminalViewerCommand(endpoint.socket, entry), /--socket/);
    assert.equal((await stat(endpoint.directory)).mode & 0o777, 0o700);
  } finally { await endpoint.cleanup(); }
});

test("controls a non-TTY viewer through bounded revision-checked frames", async () => {
  const endpoint = await createTerminalViewerEndpoint();
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--socket", endpoint.socket], { stdio: "ignore" });
  try {
    await waitForTerminalViewerSocket(endpoint.socket);
    assert.equal((await stat(endpoint.socket)).mode & 0o777, 0o600);
    const opened = await sendTerminalViewerCommand(endpoint.socket, { op: "set_scene", revision: 1, scene });
    assert.equal(opened.revision, 1);
    await assert.rejects(sendTerminalViewerCommand(endpoint.socket, { op: "set_scene", revision: 1, scene: { ...scene, elements: [] } }), /initial revision/);
    await assert.rejects(sendTerminalViewerCommand(endpoint.socket, { op: "set_scene", revision: 0, scene }), /initial revision/);
    await assert.rejects(sendTerminalViewerCommand(endpoint.socket, { op: "update", revision: 0, scene: { ...scene, elements: [] } }), /stale scene revision/);
    const updated = await sendTerminalViewerCommand(endpoint.socket, { op: "update", revision: 1, scene: { ...scene, elements: [] } });
    assert.equal(updated.revision, 2);
    const current = await sendTerminalViewerCommand(endpoint.socket, { op: "get" });
    assert.equal(current.revision, 2);
    await sendTerminalViewerCommand(endpoint.socket, { op: "close" });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await endpoint.cleanup();
  }
});

test("rejects oversized control frames before connecting", async () => {
  const endpoint = await createTerminalViewerEndpoint();
  try {
    await assert.rejects(sendTerminalViewerCommand(endpoint.socket, { op: "ping", requestId: "x".repeat(MAX_CONTROL_FRAME_BYTES) }), /frame is too large/);
  } finally { await endpoint.cleanup(); }
});

test("closes a connection that floods multiple control frames", async () => {
  const endpoint = await createTerminalViewerEndpoint();
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--socket", endpoint.socket], { stdio: "ignore" });
  try {
    await waitForTerminalViewerSocket(endpoint.socket);
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

test("restores raw mode and alternate screen when interactive input requests q", async () => {
  const endpoint = await createTerminalViewerEndpoint();
  const input = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode: (value: boolean) => void; resume: () => void; pause: () => void };
  input.isTTY = true;
  const rawModes: boolean[] = [];
  input.setRawMode = (value) => { rawModes.push(value); };
  input.resume = () => undefined;
  input.pause = () => undefined;
  const writes: string[] = [];
  const output = { isTTY: true, columns: 40, rows: 12, write(value: string) { writes.push(value); return true; } };
  const running = runTerminalViewer({ socket: endpoint.socket, stdin: input as any, stdout: output as any });
  try {
    await waitForTerminalViewerSocket(endpoint.socket);
    await sendTerminalViewerCommand(endpoint.socket, { op: "set_scene", revision: 1, scene });
    input.emit("data", Buffer.from("q"));
    await running;
    assert.deepEqual(rawModes, [true, false]);
    assert.ok(writes.some((value) => value.includes("\u001b[?1049h")));
    assert.ok(writes.some((value) => value.includes("\u001b[?1049l")));
  } finally { await endpoint.cleanup(); }
});

test("destroys newline-free oversized clients without affecting later commands", async () => {
  const endpoint = await createTerminalViewerEndpoint();
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--socket", endpoint.socket], { stdio: "ignore" });
  let attacker: net.Socket | undefined;
  try {
    await waitForTerminalViewerSocket(endpoint.socket);
    attacker = net.createConnection({ path: endpoint.socket });
    await new Promise<void>((resolve, reject) => { attacker!.once("connect", () => resolve()); attacker!.once("error", reject); });
    attacker.write("x".repeat(MAX_CONTROL_BUFFER_BYTES + 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await sendTerminalViewerCommand(endpoint.socket, { op: "ping" });
    assert.equal(response.ok, true);
  } finally {
    attacker?.destroy();
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await endpoint.cleanup();
  }
});
