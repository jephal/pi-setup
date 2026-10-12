import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clearedPlanBoardSnapshot, projectPlanBoard, renderPlanBoardAnsi, validatePlanBoardSnapshot } from "./plan-board.ts";

const plan = {
  name: "Ship board",
  kind: "plan" as const,
  content: "## In short\n\nUse a *compact* **board**.\n\n- Keep it bounded\n- [x] Preserve Pi authority\n\n```ts\nconst bounded = true;\n```\n\n```mermaid\ngraph TD\napi[API] --> board[Board]\n```", 
  steps: [{ id: 1, title: "Inspect", status: "completed" }, { id: 2, title: "Implement", status: "in_progress" }],
  identity: { name: "unused", repository: "repo", branch: "feature/board", worktree: "/repo", root: "/repo", sessionId: "session" },
  updatedAt: new Date().toISOString(),
  execution: { active: true, startedAt: new Date().toISOString() },
};

test("projects authoritative plans into bounded identity, status, markdown, checkpoints, and Mermaid art", () => {
  const snapshot = projectPlanBoard(plan);
  assert.equal(snapshot.status, "active");
  assert.match(snapshot.lines.join("\n"), /Status: active/);
  assert.match(snapshot.lines.join("\n"), /\[x\] Preserve Pi authority/);
  assert.match(snapshot.lines.join("\n"), /Task checkpoints/);
  assert.match(snapshot.lines.join("\n"), /api|API/);
  assert.ok(snapshot.markdown);
  assert.match(snapshot.markdown, /\*compact\*|\*\*board\*\*/);
  assert.match(snapshot.markdown, /- \[x\] Preserve Pi authority/);
  assert.match(snapshot.markdown, /```ts[\s\S]*const bounded = true;/);
  assert.doesNotMatch(snapshot.markdown, /```mermaid/);
  assert.match(snapshot.markdown, /api|API/);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 48 * 1024);
});

test("omits excess Mermaid blocks without leaking their source", () => {
  const fence = "```";
  const blocks = Array.from({ length: 8 }, (_, index) => `${fence}mermaid\ngraph TD\nA${index} --> B${index}\n${fence}`).join("\n\n");
  const snapshot = projectPlanBoard({ ...plan, content: blocks });
  const text = snapshot.lines.join("\n");
  assert.equal((text.match(/Additional Mermaid diagrams omitted/g) ?? []).length, 1);
  assert.doesNotMatch(text, /A6 --> B6|A7 --> B7/);

  const unclosed = projectPlanBoard({ ...plan, content: `${blocks}\n\n${fence}mermaid\ngraph TD\nEXCESS --> LEAK` });
  assert.equal((unclosed.lines.join("\n").match(/Additional Mermaid diagrams omitted/g) ?? []).length, 1);
  assert.doesNotMatch(unclosed.lines.join("\n"), /EXCESS --> LEAK/);
});

test("keeps the aggregate snapshot within bounds near the Markdown, line, and scene limits", () => {
  const largeContent = Array.from({ length: 100 }, (_, index) => `Paragraph ${index} ${"x".repeat(380)}`).join("\n");
  const scene = { type: "excalidraw", elements: [], filler: "x".repeat(23_500) };
  const snapshot = projectPlanBoard({ ...plan, content: largeContent }, { scene });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 48 * 1024);
  assert.doesNotThrow(() => validatePlanBoardSnapshot(snapshot));
});

test("normalizes non-finite dimensions and scroll positions", () => {
  const rendered = renderPlanBoardAnsi(projectPlanBoard(plan), { width: Number.NaN, height: Number.POSITIVE_INFINITY, scroll: Number.NaN });
  assert.equal(rendered.width, 80);
  assert.equal(rendered.height, 24);
  assert.equal(rendered.scroll, 0);
  const negative = renderPlanBoardAnsi(projectPlanBoard(plan), { scroll: -100 });
  assert.equal(negative.scroll, 0);
});

test("clips ANSI text at grapheme boundaries", () => {
  const family = "👩‍💻";
  const snapshot = projectPlanBoard({ ...plan, content: "# graphemes" });
  const rendered = renderPlanBoardAnsi({ ...snapshot, lines: [`${"1".repeat(18)}${family}`, "CJK 界", "combining é"] }, { width: 20, height: 10, color: false }, (_markdown, _width) => [`\u001b[31m${"1".repeat(18)}${family}\u001b[0m`, "CJK 界", "combining é"]);
  assert.match(rendered.output, new RegExp(family));
  assert.ok(rendered.output.split("\n").every((line) => visibleWidth(line) <= 20));
});

test("renders bounded scrolling and optional Excalidraw scene without unsafe controls", () => {
  const snapshot = projectPlanBoard(plan, { scene: { type: "excalidraw", elements: [{ type: "rectangle", x: 0, y: 0, width: 80, height: 30, text: "Board" }] } });
  const rendered = renderPlanBoardAnsi(snapshot, { width: 36, height: 10, color: false, scroll: 2 });
  assert.equal(rendered.width, 36);
  assert.equal(rendered.height, 10);
  assert.ok(rendered.totalLines > rendered.height);
  assert.ok(rendered.scroll >= 0);
  assert.match(rendered.output, /Plan Board/);
  assert.ok(!rendered.output.includes("\u001b["));
  assert.ok(Buffer.byteLength(rendered.output, "utf8") <= 48 * 1024);
  const full = renderPlanBoardAnsi({ ...snapshot, lines: ["# short board"] }, { width: 60, height: 24, color: false });
  assert.match(full.output, /## Excalidraw scene/);
});

test("uses shared Markdown when available and falls back without changing bounds", () => {
  const snapshot = projectPlanBoard({ ...plan, content: "# Shared heading\n\n**bold** and *italic*" });
  const shared = renderPlanBoardAnsi(snapshot, { width: 32, height: 10, color: false }, (markdown, width) => {
    assert.match(markdown, /Shared heading/);
    assert.equal(width, 32);
    return ["\u001b[31mShared heading\u001b[0m", "bold and italic"];
  });
  assert.match(shared.output, /Shared heading/);
  assert.ok(shared.output.split("\n").every((line) => visibleWidth(line) <= 32));

  const fallback = renderPlanBoardAnsi(snapshot, { width: 32, height: 10, color: false }, () => { throw new Error("renderer unavailable"); });
  assert.match(fallback.output, /Shared heading/);
  assert.ok(fallback.output.split("\n").every((line) => visibleWidth(line) <= 32));
});

test("rejects malformed snapshots and keeps clear status safe", () => {
  const cleared = clearedPlanBoardSnapshot({ name: "x", repository: "repo", branch: "main", root: "/repo", sessionId: "s" });
  assert.equal(validatePlanBoardSnapshot(cleared).status, "cleared");
  assert.throws(() => validatePlanBoardSnapshot({ version: 1, title: "x", status: "active", lines: [], identity: {} }), /identity/);
  assert.throws(() => validatePlanBoardSnapshot({ version: 1, title: "x", status: "bad", lines: [], identity: cleared.identity }), /status/);
});
