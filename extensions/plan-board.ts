import { render as renderMermaid } from "grok-mermaid";
import { renderExcalidrawAnsi, terminalDisplayWidth, type TerminalRenderOptions } from "./excalidraw-terminal-renderer.ts";
import type { StoredPlan } from "../src/plan-mode/storage.ts";

export const PLAN_BOARD_MAX_BYTES = 48 * 1024;
export const PLAN_BOARD_MAX_LINES = 240;
export const PLAN_BOARD_MAX_CONTENT_LINES = 120;
export const PLAN_BOARD_MAX_MARKDOWN_BYTES = 24 * 1024;
export const PLAN_BOARD_MAX_MERMAID_BLOCKS = 6;
export const PLAN_BOARD_MAX_MERMAID_CHARS = 8_000;
export const PLAN_BOARD_MAX_SCENE_BYTES = 256 * 1024;

export type PlanBoardStatus = "draft" | "active" | "complete" | "cleared";

export interface PlanBoardIdentity {
  name: string;
  repository: string;
  branch: string;
  root: string;
  sessionId: string;
}

export interface PlanBoardSnapshot {
  version: 1;
  title: string;
  status: PlanBoardStatus;
  identity: PlanBoardIdentity;
  /** Bounded Markdown for the shared Pi renderer. `lines` remains the safe fallback. */
  markdown?: string;
  lines: string[];
  scene?: Record<string, unknown>;
}

export interface PlanBoardProjectionOptions {
  scene?: Record<string, unknown>;
  maxLines?: number;
}

export interface PlanBoardRenderOptions extends TerminalRenderOptions {
  scroll?: number;
}

export type PlanBoardMarkdownRenderer = (markdown: string, width: number) => string[];

export interface PlanBoardRenderResult {
  output: string;
  width: number;
  height: number;
  scroll: number;
  totalLines: number;
  unsupported: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, max = 400): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}…`, "utf8") > maxBytes) break;
    result += character;
  }
  return `${result}…`;
}

function isComplete(plan: StoredPlan): boolean {
  return plan.steps.length > 0 && plan.steps.every((step) => ["complete", "completed", "done"].includes(step.status.trim().toLowerCase()));
}

function statusFor(plan: StoredPlan): PlanBoardStatus {
  if (plan.execution?.active) return "active";
  if (plan.execution?.completedAt || isComplete(plan)) return "complete";
  return "draft";
}

function checkpointLine(id: number, title: string, status: string): string {
  const normalized = status.trim().toLowerCase();
  const checked = ["complete", "completed", "done"].includes(normalized) ? "x" : " ";
  const suffix = normalized === "in_progress" || normalized === "in-progress" ? " *(in progress)*" : "";
  return `- [${checked}] ${id}. ${safeText(title, 240)}${suffix}`;
}

function mermaidLines(source: string): string[] {
  const bounded = boundedUtf8(source.replace(/\r\n?/g, "\n").trim(), PLAN_BOARD_MAX_MERMAID_CHARS);
  try {
    const art = renderMermaid(bounded);
    if (art) {
      const rows = art.plain.slice(0, 80).map((row) => safeText(row, 240));
      if (art.warnings.length) rows.push(`[Mermaid note: ${safeText(art.warnings[0], 180)}]`);
      return rows.length ? rows : ["[Mermaid diagram is empty]"];
    }
  } catch {
    // A board must remain usable when a diagram is incomplete or unsupported.
  }
  return ["[Mermaid diagram unavailable: unsupported or invalid syntax]"];
}

function sanitizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Replace Mermaid fences before the shared Markdown parser sees them. */
function preprocessMarkdown(content: string): string {
  const source = boundedUtf8(sanitizeMarkdown(content), 16 * 1024);
  const output: string[] = [];
  let inMermaid = false;
  let mermaid: string[] = [];
  let blockCount = 0;
  let omitted = false;
  const appendDiagram = (sourceBlock: string) => {
    if (blockCount >= PLAN_BOARD_MAX_MERMAID_BLOCKS) {
      if (!omitted) { output.push("[Additional Mermaid diagrams omitted]"); omitted = true; }
      return;
    }
    output.push("```text", ...mermaidLines(sourceBlock), "```");
    blockCount++;
  };
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (/^```\s*mermaid\s*$/i.test(line)) {
      inMermaid = true;
      mermaid = [];
      continue;
    }
    if (inMermaid && /^```\s*$/.test(line)) {
      appendDiagram(mermaid.join("\n"));
      inMermaid = false;
      mermaid = [];
      continue;
    }
    if (inMermaid) {
      if (mermaid.join("\n").length < PLAN_BOARD_MAX_MERMAID_CHARS) mermaid.push(rawLine);
      continue;
    }
    output.push(rawLine);
  }
  if (inMermaid) appendDiagram(mermaid.join("\n"));
  return boundedUtf8(output.join("\n"), PLAN_BOARD_MAX_MARKDOWN_BYTES);
}

function markdownProjection(plan: StoredPlan, status: PlanBoardStatus, completed: number): string {
  const name = safeText(plan.name, 160) || "Plan Board";
  const checkpoints = plan.steps.slice(0, 60).map((step) => checkpointLine(step.id, step.title, step.status));
  return boundedUtf8(sanitizeMarkdown([
    `# ${name}`,
    `**Status:** ${status} · **Checkpoints:** ${completed}/${plan.steps.length}`,
    `**Repository:** ${safeText(plan.identity.repository, 120)} · **Branch:** ${safeText(plan.identity.branch, 160)}`,
    "",
    preprocessMarkdown(plan.content),
    "",
    "## Task checkpoints",
    ...checkpoints,
  ].join("\n")), PLAN_BOARD_MAX_MARKDOWN_BYTES);
}

function markdownLines(content: string, maxLines: number): { lines: string[]; diagrams: string[][] } {
  const source = boundedUtf8(content, 24 * 1024).replace(/\r\n?/g, "\n");
  const raw = source.split("\n");
  const lines: string[] = [];
  const diagrams: string[][] = [];
  let inMermaid = false;
  let mermaid: string[] = [];
  let mermaidBlocks = 0;
  let omittedMermaid = false;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    lines.push(`  ${safeText(paragraph.join(" "), 400)}`);
    paragraph = [];
  };
  for (const rawLine of raw) {
    const line = rawLine.trim();
    if (/^```\s*mermaid\s*$/i.test(line)) {
      flushParagraph();
      // Continue consuming excess Mermaid blocks through their closing fence.
      // Otherwise their source would leak into the ordinary Markdown projection.
      inMermaid = true;
      mermaid = [];
      if (mermaidBlocks >= PLAN_BOARD_MAX_MERMAID_BLOCKS && !omittedMermaid) {
        lines.push("  [Additional Mermaid diagrams omitted]");
        omittedMermaid = true;
      }
      continue;
    }
    if (inMermaid && /^```\s*$/.test(line)) {
      if (mermaidBlocks < PLAN_BOARD_MAX_MERMAID_BLOCKS) {
        const sourceBlock = mermaid.join("\n");
        lines.push("  Mermaid diagram:");
        diagrams.push(mermaidLines(sourceBlock));
        mermaidBlocks++;
      }
      inMermaid = false;
      mermaid = [];
      continue;
    }
    if (inMermaid) {
      if (mermaid.join("\n").length < PLAN_BOARD_MAX_MERMAID_CHARS) mermaid.push(rawLine);
      continue;
    }
    if (!line) { flushParagraph(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); lines.push(`${heading[1]} ${safeText(heading[2], 240)}`); continue; }
    const checklist = line.match(/^[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checklist) { flushParagraph(); lines.push(`  - [${checklist[1].toLowerCase() === "x" ? "x" : " "}] ${safeText(checklist[2], 280)}`); continue; }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) { flushParagraph(); lines.push(`  • ${safeText(bullet[1], 280)}`); continue; }
    if (/^```/.test(line)) { flushParagraph(); lines.push("  [Code block omitted]"); continue; }
    paragraph.push(line);
  }
  if (inMermaid && mermaidBlocks < PLAN_BOARD_MAX_MERMAID_BLOCKS) {
    lines.push("  Mermaid diagram:");
    diagrams.push(mermaidLines(mermaid.join("\n")));
  }
  flushParagraph();
  return { lines: lines.slice(0, maxLines), diagrams: diagrams.slice(0, PLAN_BOARD_MAX_MERMAID_BLOCKS) };
}

/** Build a bounded, display-only projection from the authoritative saved Pi plan. */
export function projectPlanBoard(plan: StoredPlan, options: PlanBoardProjectionOptions = {}): PlanBoardSnapshot {
  const maxLines = Math.min(PLAN_BOARD_MAX_CONTENT_LINES, Math.max(1, Math.floor(options.maxLines ?? PLAN_BOARD_MAX_CONTENT_LINES)));
  const status = statusFor(plan);
  const content = markdownLines(plan.content, maxLines);
  const completed = plan.steps.filter((step) => ["complete", "completed", "done"].includes(step.status.trim().toLowerCase())).length;
  const markdown = markdownProjection(plan, status, completed);
  const lines = [
    `# ${safeText(plan.name, 160) || "Plan Board"}`,
    `Status: ${status} · Checkpoints: ${completed}/${plan.steps.length}`,
    `Repository: ${safeText(plan.identity.repository, 120)} · Branch: ${safeText(plan.identity.branch, 160)}`,
    "",
    ...content.lines,
    "",
    "## Task checkpoints",
    ...plan.steps.slice(0, 60).map((step) => checkpointLine(step.id, step.title, step.status)),
  ];
  for (const diagram of content.diagrams) lines.push("", ...diagram);
  let scene = options.scene;
  try {
    if (scene && Buffer.byteLength(JSON.stringify(scene), "utf8") > PLAN_BOARD_MAX_BYTES / 2) scene = undefined;
  } catch { scene = undefined; }
  const snapshot: PlanBoardSnapshot = {
    version: 1,
    title: safeText(plan.name, 160) || "Plan Board",
    status,
    identity: {
      name: safeText(plan.name, 160),
      repository: safeText(plan.identity.repository, 120),
      branch: safeText(plan.identity.branch, 160),
      root: safeText(plan.identity.root, 240),
      sessionId: safeText(plan.identity.sessionId, 160),
    },
    markdown,
    lines: lines.slice(0, PLAN_BOARD_MAX_LINES).map((line) => boundedUtf8(line, 500)),
    ...(scene ? { scene } : {}),
  };
  const snapshotBytes = () => Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (snapshotBytes() > PLAN_BOARD_MAX_BYTES) {
    // Check the aggregate size after each reduction. The Markdown, fallback
    // lines, and optional scene are independently bounded, but their sum is
    // not; a scene is the least important part of the derived snapshot.
    snapshot.lines = [...snapshot.lines.slice(0, 39), "[Plan Board content truncated safely]"];
  }
  if (snapshotBytes() > PLAN_BOARD_MAX_BYTES && snapshot.markdown) {
    snapshot.markdown = boundedUtf8(snapshot.markdown, 16 * 1024);
  }
  if (snapshotBytes() > PLAN_BOARD_MAX_BYTES && snapshot.scene) {
    delete snapshot.scene;
  }
  // These final reductions are defensive for JSON overhead and keep this
  // projector's return value valid even if the individual bounds change.
  if (snapshotBytes() > PLAN_BOARD_MAX_BYTES && snapshot.markdown) {
    snapshot.markdown = boundedUtf8(snapshot.markdown, 8 * 1024);
  }
  if (snapshotBytes() > PLAN_BOARD_MAX_BYTES) snapshot.lines = snapshot.lines.slice(0, 8);
  if (snapshotBytes() > PLAN_BOARD_MAX_BYTES) delete snapshot.markdown;
  return snapshot;
}

export function clearedPlanBoardSnapshot(identity: PlanBoardIdentity, name = "Plan Board"): PlanBoardSnapshot {
  return {
    version: 1,
    title: safeText(name, 160) || "Plan Board",
    status: "cleared",
    identity: { ...identity, name: safeText(name, 160) },
    markdown: "# Plan Board\n\n**Status:** cleared\n\nNo active plan for this branch.",
    lines: ["# Plan Board", "Status: cleared", "", "No active plan for this branch."],
  };
}

const ANSI_SEQUENCE = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -\/]*[@-~])/y;
const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

function nextGrapheme(value: string, index: number): string {
  // Keep escape sequences outside the segmenter input. They have zero display
  // width, but including one in a grapheme cluster would make the clipping
  // boundary depend on ANSI styling rather than visible text.
  const escape = value.indexOf("\u001b", index);
  const end = escape < 0 ? value.length : escape;
  const text = value.slice(index, end);
  if (!text) return value[index] ?? "";
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment)[0] ?? "" : [...text][0] ?? "";
}

function clipDisplay(value: string, width: number): string {
  let result = "";
  let used = 0;
  let index = 0;
  while (index < value.length) {
    ANSI_SEQUENCE.lastIndex = index;
    const match = ANSI_SEQUENCE.exec(value);
    if (match?.index === index) {
      result += match[0];
      index += match[0].length;
      continue;
    }
    const grapheme = nextGrapheme(value, index);
    if (!grapheme) break;
    const size = terminalDisplayWidth(grapheme);
    if (used + size > width) break;
    result += grapheme;
    used += size;
    index += grapheme.length;
  }
  return result;
}

function wrapLine(value: string, width: number): string[] {
  const text = safeText(value, 500);
  if (!text) return [""];
  const result: string[] = [];
  let rest = text;
  while (terminalDisplayWidth(rest) > width) {
    const clipped = clipDisplay(rest, width);
    const split = clipped.lastIndexOf(" ");
    const cut = split > Math.floor(width * 0.5) ? split : clipped.length;
    result.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  result.push(rest);
  return result;
}

/** Render a snapshot into bounded ANSI/Unicode rows. The optional shared renderer is isolated so the plain fallback stays dependency-free. */
export function renderPlanBoardAnsi(snapshot: PlanBoardSnapshot, options: PlanBoardRenderOptions = {}, markdownRenderer?: PlanBoardMarkdownRenderer): PlanBoardRenderResult {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.lines)) throw new Error("invalid Plan Board snapshot");
  const finiteDimension = (value: number | undefined, fallback: number): number => Number.isFinite(value) ? value as number : fallback;
  const width = Math.max(20, Math.min(240, Math.floor(finiteDimension(options.width, 80))));
  const height = Math.max(8, Math.min(120, Math.floor(finiteDimension(options.height, 24))));
  let rows: string[] | undefined;
  if (snapshot.markdown && markdownRenderer) {
    try {
      const rendered = markdownRenderer(snapshot.markdown, width);
      if (Array.isArray(rendered) && rendered.length > 0 && rendered.every((line) => typeof line === "string")) rows = rendered.slice(0, PLAN_BOARD_MAX_LINES * 4);
    } catch {
      // Fall through to the dependency-free lines projection.
    }
  }
  if (!rows) {
    rows = [];
    for (const line of snapshot.lines.slice(0, PLAN_BOARD_MAX_LINES)) rows.push(...wrapLine(line, width));
  }
  const sceneRows: string[] = [];
  let unsupported: string[] = [];
  if (snapshot.scene) {
    try {
      const scene = renderExcalidrawAnsi(snapshot.scene, { width, height: Math.max(8, height - 4), color: options.color });
      sceneRows.push("", "## Excalidraw scene", ...scene.output.split("\n"));
      unsupported = scene.unsupported;
    } catch {
      sceneRows.push("", "[Excalidraw scene unavailable: unsupported or invalid scene]");
    }
  }
  const allRows = [...rows, ...sceneRows];
  const maxScroll = Math.max(0, allRows.length - Math.max(1, height - 2));
  const requestedScroll = finiteDimension(options.scroll, 0);
  const scroll = Math.max(0, Math.min(maxScroll, Math.floor(requestedScroll)));
  const visible = allRows.slice(scroll, scroll + Math.max(1, height - 2));
  const header = clipDisplay(`Plan Board · ${safeText(snapshot.title, 120)} · ${snapshot.status} · ${scroll + 1}-${Math.min(allRows.length, scroll + visible.length)}/${allRows.length}`, width);
  const notice = clipDisplay(unsupported.length ? `Unsupported Excalidraw elements omitted: ${unsupported.join(", ")}` : "Mouse wheel or j/k scroll · PgUp/PgDn page · Home/End jump · r redraw · q quit", width);
  const output = [header, ...visible, notice].map((line) => clipDisplay(line, width)).join("\n");
  return { output: boundedUtf8(output, PLAN_BOARD_MAX_BYTES), width, height, scroll, totalLines: allRows.length, unsupported };
}

export function validatePlanBoardSnapshot(value: unknown): PlanBoardSnapshot {
  if (!isRecord(value) || value.version !== 1 || typeof value.title !== "string" || !Array.isArray(value.lines) || !isRecord(value.identity)) throw new Error("invalid Plan Board snapshot");
  if (!["draft", "active", "complete", "cleared"].includes(value.status as string)) throw new Error("invalid Plan Board status");
  const identity = value.identity;
  const required = ["name", "repository", "branch", "root", "sessionId"];
  if (!required.every((key) => typeof identity[key] === "string")) throw new Error("invalid Plan Board identity");
  const markdown = typeof value.markdown === "string" ? boundedUtf8(sanitizeMarkdown(value.markdown), PLAN_BOARD_MAX_MARKDOWN_BYTES) : undefined;
  const lines = value.lines.filter((line): line is string => typeof line === "string").slice(0, PLAN_BOARD_MAX_LINES).map((line) => boundedUtf8(line, 500));
  const snapshot: PlanBoardSnapshot = { version: 1, title: safeText(value.title, 160), status: value.status as PlanBoardStatus, identity: { name: safeText(identity.name, 160), repository: safeText(identity.repository, 120), branch: safeText(identity.branch, 160), root: safeText(identity.root, 240), sessionId: safeText(identity.sessionId, 160) }, ...(markdown !== undefined ? { markdown } : {}), lines };
  if (isRecord(value.scene) && value.scene.type === "excalidraw" && Buffer.byteLength(JSON.stringify(value.scene), "utf8") <= PLAN_BOARD_MAX_SCENE_BYTES) snapshot.scene = value.scene;
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > PLAN_BOARD_MAX_BYTES) throw new Error("Plan Board snapshot is too large.");
  return snapshot;
}
