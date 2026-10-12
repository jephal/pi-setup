import assert from "node:assert/strict";
import test from "node:test";
import { renderExcalidrawAnsi, normalizeTerminalSize, terminalDisplayWidth, TERMINAL_MAX_WIDTH, TERMINAL_MIN_HEIGHT } from "./excalidraw-terminal-renderer.ts";

test("renders the supported graph subset with labels and bounded dimensions", () => {
  const scene = { type: "excalidraw", elements: [
    { type: "rectangle", x: 0, y: 0, width: 100, height: 50, text: "API" },
    { type: "arrow", x: 100, y: 20, width: 100, height: 0, points: [[0, 0], [100, 0]], endArrowhead: "arrow" },
    { type: "text", x: 210, y: 10, width: 40, height: 20, text: "Database" },
  ] };
  const rendered = renderExcalidrawAnsi(scene, { width: 999, height: 2, color: false });
  assert.equal(rendered.width, TERMINAL_MAX_WIDTH);
  assert.equal(rendered.height, TERMINAL_MIN_HEIGHT);
  assert.match(rendered.output, /API/);
  assert.match(rendered.output, /Database/);
  assert.deepEqual(rendered.unsupported, []);
});

test("renders distinct shapes, routed connectors, and narrow-pane guidance", () => {
  const rendered = renderExcalidrawAnsi({ type: "excalidraw", elements: [
    { type: "ellipse", x: 0, y: 0, width: 40, height: 20, text: "Start" },
    { type: "diamond", x: 60, y: 0, width: 40, height: 20, text: "Check" },
    { type: "arrow", x: 40, y: 10, width: 20, height: 0, points: [[0, 0], [20, 0]], endArrowhead: "arrow", text: "yes" },
  ] }, { width: 20, height: 8, color: false });
  assert.match(rendered.output, /Start|Check/);
  assert.match(rendered.output, /Narrow pane/);
});

test("reports unsupported elements without executing their contents", () => {
  const rendered = renderExcalidrawAnsi({ type: "excalidraw", elements: [
    { type: "rectangle", x: 0, y: 0, width: 4, height: 2 },
    { type: "image", text: "ignored" },
  ] }, { width: 40, height: 10, color: false });
  assert.deepEqual(rendered.unsupported, ["image"]);
  assert.match(rendered.output, /Unsupported elements omitted: image/);
  assert.doesNotMatch(rendered.output, /ignored/);
});

test("rejects malformed scenes and excessive labels", () => {
  assert.throws(() => renderExcalidrawAnsi({ type: "excalidraw", elements: [null] }), /objects/);
  assert.throws(() => renderExcalidrawAnsi({ type: "excalidraw", elements: Array.from({ length: 201 }, (_, i) => ({ type: "text", text: String(i) })) }), /labels/);
  assert.throws(() => normalizeTerminalSize(Number.NaN, 20), /finite/);
});

test("bounds only supported elements and terminates on extreme finite geometry", { timeout: 1_000 }, () => {
  const rendered = renderExcalidrawAnsi({ type: "excalidraw", elements: [
    { type: "rectangle", x: 0, y: 0, width: 4, height: 2, text: "safe" },
    { type: "image", x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: Number.MAX_VALUE, height: Number.MAX_VALUE, text: "ignored" },
    { type: "line", x: Number.MAX_VALUE, y: -Number.MAX_VALUE, width: Number.MAX_VALUE, height: Number.MAX_VALUE, points: [[0, 0], [Number.MAX_VALUE, Number.MAX_VALUE]] },
  ] }, { width: 40, height: 10, color: false });
  assert.deepEqual(rendered.unsupported, ["image"]);
  assert.equal(rendered.elementCount, 3);
  assert.doesNotMatch(rendered.output, /ignored/);
});

test("clears wide grapheme continuation cells before overlapping geometry", () => {
  const rendered = renderExcalidrawAnsi({ type: "excalidraw", elements: [
    { type: "text", x: 0, y: 0, text: "界" },
    { type: "arrow", x: 0, y: 0, width: 1, height: 0, points: [[0, 0], [1, 0]], endArrowhead: "arrow" },
  ] }, { width: 20, height: 8, color: false });
  for (const row of rendered.output.split("\n")) assert.ok(terminalDisplayWidth(row) <= rendered.width);
  assert.match(rendered.output, /▶/);
});

test("clips ANSI and Unicode by terminal display columns", () => {
  const rendered = renderExcalidrawAnsi({ type: "excalidraw", elements: [
    { type: "text", x: 0, y: 0, text: "界😀e\u0301" },
  ] }, { width: 20, height: 8, color: true });
  const ansi = /\u001b\[[0-9;]*m/g;
  for (const row of rendered.output.split("\n")) assert.ok(terminalDisplayWidth(row.replace(ansi, "")) <= rendered.width);
  assert.equal((rendered.output.match(/\u001b\[[0-9;]+m/g) || []).filter((code) => code !== "\u001b[0m").length, (rendered.output.match(/\u001b\[0m/g) || []).length);
  assert.ok(rendered.output.includes("界"));
});
