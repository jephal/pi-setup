/** Pure ANSI/Unicode renderer for the intentionally small Excalidraw subset. */

export const TERMINAL_MIN_WIDTH = 20;
export const TERMINAL_MAX_WIDTH = 240;
export const TERMINAL_MIN_HEIGHT = 8;
export const TERMINAL_MAX_HEIGHT = 120;
export const MAX_TERMINAL_ELEMENTS = 500;
export const MAX_TERMINAL_LABELS = 200;
export const MAX_TERMINAL_LABEL_CHARS = 120;
export const MAX_TERMINAL_OUTPUT_BYTES = 256 * 1024;

/** Keep arithmetic far away from Number.MAX_VALUE and keep hostile scenes cheap. */
export const TERMINAL_WORLD_COORDINATE_LIMIT = 1_000_000;
const MAX_UNSUPPORTED_TYPES = 32;
const MAX_UNSUPPORTED_TYPE_CHARS = 40;

export interface TerminalRenderOptions {
  width?: number;
  height?: number;
  panX?: number;
  panY?: number;
  zoom?: number;
  color?: boolean;
}

export interface NormalizedTerminalSize { width: number; height: number; }
export interface TerminalRenderResult {
  output: string;
  width: number;
  height: number;
  unsupported: string[];
  elementCount: number;
  labelCount: number;
}

interface Point { x: number; y: number; }
interface ElementRecord { type?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; text?: unknown; points?: unknown; endArrowhead?: unknown; }
interface Cell { text: string; style?: string; continuation?: boolean; primaryX?: number; span?: number; }
interface Geometry { x: number; y: number; width: number; height: number; points: Point[]; }

const SUPPORTED = new Set(["rectangle", "diamond", "ellipse", "line", "arrow", "text"]);

export function normalizeTerminalSize(width = 80, height = 24): NormalizedTerminalSize {
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("terminal width and height must be finite numbers.");
  return {
    width: Math.min(TERMINAL_MAX_WIDTH, Math.max(TERMINAL_MIN_WIDTH, Math.floor(width))),
    height: Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, Math.floor(height))),
  };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function world(value: unknown, fallback = 0): number {
  const number = Math.max(-TERMINAL_WORLD_COORDINATE_LIMIT, Math.min(TERMINAL_WORLD_COORDINATE_LIMIT, finite(value, fallback)));
  return Number.isFinite(number) ? number : fallback;
}
function boundedText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "");
  return graphemes(normalized).slice(0, MAX_TERMINAL_LABEL_CHARS).join("");
}

// A small wcwidth-compatible implementation. Grapheme clusters keep emoji
// sequences and combining marks from being counted as multiple terminal cells.
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
function codePointWidth(codePoint: number): number {
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) || (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || codePoint === 0x200d) return 0;
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0x2329 && codePoint <= 0x232a) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) || (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60) || (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff)) return 2;
  return 1;
}
function graphemeWidth(value: string): number {
  const codePoints = [...value].map((character) => character.codePointAt(0) ?? 0);
  if (codePoints.some((codePoint) => codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)) return 2;
  if (codePoints.some((codePoint) => codePoint >= 0x1f300 && codePoint <= 0x1faff)) return 2;
  return Math.min(2, codePoints.reduce((total, codePoint) => total + codePointWidth(codePoint), 0));
}
function graphemes(value: string): string[] {
  return segmenter ? [...segmenter.segment(value)].map((part) => part.segment) : [...value];
}
export function terminalDisplayWidth(value: string): number {
  return graphemes(value).reduce((total, part) => total + graphemeWidth(part), 0);
}
function clipDisplay(value: string, width: number): string {
  let result = "";
  let used = 0;
  for (const part of graphemes(value)) {
    const partWidth = graphemeWidth(part);
    if (used + partWidth > width) break;
    result += part;
    used += partWidth;
  }
  return result;
}
function style(enabled: boolean, code: string, value: string): string { return enabled && code && value ? `\u001b[${code}m${value}\u001b[0m` : value; }
function blankCanvas(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, (_, primaryX) => ({ text: "", primaryX, span: 1 })));
}
function clearCell(canvas: Cell[][], x: number, y: number): void {
  const row = canvas[y];
  if (!row || x < 0 || x >= row.length) return;
  const primaryX = row[x].primaryX ?? x;
  const span = row[primaryX]?.span ?? 1;
  for (let column = primaryX; column < Math.min(row.length, primaryX + span); column++) row[column] = { text: "", primaryX: column, span: 1 };
}
function put(canvas: Cell[][], x: number, y: number, value: string, cellStyle?: string): void {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || y < 0 || y >= canvas.length) return;
  let column = x;
  let previous: Cell | undefined;
  for (const part of graphemes(value)) {
    const partWidth = graphemeWidth(part);
    if (partWidth === 0) {
      if (previous) previous.text += part;
      continue;
    }
    if (column >= 0 && column + partWidth <= canvas[y].length) {
      for (let offset = 0; offset < partWidth; offset++) clearCell(canvas, column + offset, y);
      const primary = { text: part, style: cellStyle, primaryX: column, span: partWidth };
      canvas[y][column] = primary;
      for (let offset = 1; offset < partWidth; offset++) canvas[y][column + offset] = { text: "", continuation: true, primaryX: column, span: partWidth };
      previous = primary;
    }
    column += partWidth;
  }
}
function line(canvas: Cell[][], x0: number, y0: number, x1: number, y1: number, character: string): void {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  // Even if a future projection change produces an outside endpoint, drawing
  // work is bounded by the canvas rather than by hostile world coordinates.
  const limit = (canvas.length + 1) * (canvas[0]?.length + 1) * 4 + 4;
  for (let iterations = 0; iterations < limit; iterations++) {
    if (y0 >= 0 && y0 < canvas.length && x0 >= 0 && x0 < canvas[0].length) put(canvas, x0, y0, character);
    if (x0 === x1 && y0 === y1) return;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x0 += sx; }
    if (twice <= dx) { error += dx; y0 += sy; }
  }
}
function rectangle(canvas: Cell[][], left: number, top: number, right: number, bottom: number, chars: [string, string, string, string, string]): void {
  const [tl, tr, bl, br, horizontal] = chars;
  line(canvas, left, top, right, top, horizontal);
  line(canvas, left, bottom, right, bottom, horizontal);
  line(canvas, left, top, left, bottom, "│");
  line(canvas, right, top, right, bottom, "│");
  put(canvas, left, top, tl); put(canvas, right, top, tr); put(canvas, left, bottom, bl); put(canvas, right, bottom, br);
}
function ellipse(canvas: Cell[][], left: number, top: number, right: number, bottom: number): void {
  if (right - left < 4 || bottom - top < 2) { rectangle(canvas, left, top, right, bottom, ["(", ")", "(", ")", "─"]); return; }
  const centerX = (left + right) / 2, centerY = (top + bottom) / 2;
  const radiusX = Math.max(1, (right - left) / 2), radiusY = Math.max(1, (bottom - top) / 2);
  let previous = { x: Math.round(centerX + radiusX), y: Math.round(centerY) };
  for (let step = 1; step <= 24; step++) {
    const angle = (step / 24) * Math.PI * 2;
    const next = { x: Math.round(centerX + Math.cos(angle) * radiusX), y: Math.round(centerY + Math.sin(angle) * radiusY) };
    line(canvas, previous.x, previous.y, next.x, next.y, "·");
    previous = next;
  }
}
function project(point: Point, bounds: { minX: number; minY: number; scaleX: number; scaleY: number }, options: Required<Pick<TerminalRenderOptions, "panX" | "panY" | "zoom">>): Point {
  const x = Math.round((point.x - bounds.minX) * bounds.scaleX * options.zoom + options.panX);
  const y = Math.round((point.y - bounds.minY) * bounds.scaleY * options.zoom + options.panY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("scene geometry produced non-finite terminal coordinates.");
  return { x, y };
}
function geometry(element: ElementRecord): Geometry {
  const x = world(element.x), y = world(element.y);
  const width = Math.max(0, world(element.width));
  const height = Math.max(0, world(element.height));
  const points = Array.isArray(element.points) ? element.points.filter(Array.isArray).map((point) => ({ x: world(point[0]), y: world(point[1]) })) : [];
  // All derived endpoints are checked after clamping, not just their inputs.
  for (const point of [{ x, y }, { x: x + width, y: y + height }, ...points.map((point) => ({ x: x + point.x, y: y + point.y }))]) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("scene geometry produced non-finite terminal coordinates.");
  }
  return { x, y, width, height, points };
}
function elementBounds(elements: ElementRecord[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = 0, minY = 0, maxX = 1, maxY = 1;
  for (const element of elements) {
    const item = geometry(element);
    minX = Math.min(minX, item.x); minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width); maxY = Math.max(maxY, item.y + item.height);
    for (const point of item.points) {
      minX = Math.min(minX, item.x + point.x); minY = Math.min(minY, item.y + point.y);
      maxX = Math.max(maxX, item.x + point.x); maxY = Math.max(maxY, item.y + point.y);
    }
  }
  return { minX, minY, maxX: Math.max(maxX, minX + 1), maxY: Math.max(maxY, minY + 1) };
}
function renderCells(row: Cell[], color: boolean): string {
  return row.map((cell) => style(color, cell.style ?? "", cell.text || (cell.continuation ? "" : " "))).join("");
}
function boundedOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_TERMINAL_OUTPUT_BYTES) return value;
  let result = "";
  for (const part of graphemes(value)) {
    if (Buffer.byteLength(`${result}${part}\n[output bounded]`, "utf8") > MAX_TERMINAL_OUTPUT_BYTES) break;
    result += part;
  }
  return `${result}\n[output bounded]`;
}

/** Render a scene without importing Pi, Excalidraw, a browser, or a terminal UI package. */
export function renderExcalidrawAnsi(scene: unknown, options: TerminalRenderOptions = {}): TerminalRenderResult {
  if (!record(scene) || scene.type !== "excalidraw") throw new Error("scene.type must be excalidraw.");
  if (!Array.isArray(scene.elements)) throw new Error("scene.elements must be an array.");
  if (scene.elements.length > MAX_TERMINAL_ELEMENTS) throw new Error(`scene.elements is limited to ${MAX_TERMINAL_ELEMENTS} items.`);
  const size = normalizeTerminalSize(options.width ?? 80, options.height ?? 24);
  const settings = {
    panX: Math.max(-TERMINAL_WORLD_COORDINATE_LIMIT, Math.min(TERMINAL_WORLD_COORDINATE_LIMIT, finite(options.panX, 0))),
    panY: Math.max(-TERMINAL_WORLD_COORDINATE_LIMIT, Math.min(TERMINAL_WORLD_COORDINATE_LIMIT, finite(options.panY, 0))),
    zoom: Math.min(8, Math.max(0.2, finite(options.zoom, 1))),
    color: options.color !== false,
  };
  if (!scene.elements.every(record)) throw new Error("scene.elements may contain only objects.");
  const allElements = scene.elements as ElementRecord[];
  const elements = allElements.filter((element) => SUPPORTED.has(typeof element.type === "string" ? element.type : "unknown"));
  const unsupported = [...new Set(allElements
    .map((element) => typeof element.type === "string" ? element.type : "unknown")
    .filter((type) => !SUPPORTED.has(type)))]
    .slice(0, MAX_UNSUPPORTED_TYPES)
    .map((type) => type.slice(0, MAX_UNSUPPORTED_TYPE_CHARS));
  const labels = elements.map((element) => boundedText(element.text)).filter(Boolean);
  if (labels.length > MAX_TERMINAL_LABELS) throw new Error(`scene labels are limited to ${MAX_TERMINAL_LABELS} items.`);
  const bounds = elementBounds(elements);
  const canvasHeight = Math.max(1, size.height - 2);
  const canvas = blankCanvas(size.width, canvasHeight);
  const worldWidth = Math.max(1, bounds.maxX - bounds.minX), worldHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scaleX = Math.max(0.01, (size.width - 4) / worldWidth);
  const scaleY = Math.max(0.01, (canvasHeight - 2) / worldHeight);
  const projection = { minX: bounds.minX, minY: bounds.minY, scaleX, scaleY };
  const headerText = clipDisplay(`Excalidraw terminal view · ${allElements.length} elements · zoom ${settings.zoom.toFixed(1)}x`, size.width);

  for (const element of elements) {
    const type = String(element.type);
    const item = geometry(element);
    const topLeft = project({ x: item.x, y: item.y }, projection, settings);
    const bottomRight = project({ x: item.x + item.width, y: item.y + item.height }, projection, settings);
    const left = Math.min(topLeft.x, bottomRight.x), right = Math.max(left + 2, bottomRight.x);
    const top = Math.min(topLeft.y, bottomRight.y), bottom = Math.max(top + 1, bottomRight.y);
    const label = boundedText(element.text);
    if (type === "text") {
      put(canvas, topLeft.x, topLeft.y, label, settings.color ? "1;33" : undefined);
      continue;
    }
    if (type === "rectangle") rectangle(canvas, left, top, right, bottom, ["┌", "┐", "└", "┘", "─"]);
    else if (type === "diamond") {
      const cx = Math.round((left + right) / 2), cy = Math.round((top + bottom) / 2);
      line(canvas, cx, top, right, cy, "╱"); line(canvas, right, cy, cx, bottom, "╲"); line(canvas, cx, bottom, left, cy, "╱"); line(canvas, left, cy, cx, top, "╲");
    } else if (type === "ellipse") ellipse(canvas, left, top, right, bottom);
    else {
      const points = item.points.length >= 2 ? item.points : [{ x: 0, y: item.height / 2 }, { x: item.width, y: item.height / 2 }];
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1], to = points[index];
        const a = project({ x: item.x + from.x, y: item.y + from.y }, projection, settings);
        const b = project({ x: item.x + to.x, y: item.y + to.y }, projection, settings);
        const dx = b.x - a.x, dy = b.y - a.y;
        const connector = Math.abs(dx) > Math.abs(dy) * 2 ? "─" : Math.abs(dy) > Math.abs(dx) * 2 ? "│" : (dx * dy >= 0 ? "╲" : "╱");
        line(canvas, a.x, a.y, b.x, b.y, connector);
        if (index === points.length - 1 && (type === "arrow" || (element.endArrowhead !== undefined && element.endArrowhead !== "none"))) {
          const arrowhead = Math.abs(dx) > Math.abs(dy) * 2 ? (dx >= 0 ? "▶" : "◀") : Math.abs(dy) > Math.abs(dx) * 2 ? (dy >= 0 ? "▼" : "▲") : "◆";
          put(canvas, b.x, b.y, arrowhead);
        }
      }
    }
    if (label) {
      const labelWidth = terminalDisplayWidth(label);
      const labelX = Math.max(left + 1, Math.floor((left + right - labelWidth) / 2));
      const labelY = Math.max(top + 1, Math.floor((top + bottom) / 2));
      put(canvas, labelX, labelY, label, settings.color ? "33" : undefined);
    }
  }

  const noticeText = unsupported.length
    ? `Unsupported elements omitted: ${unsupported.join(", ")}`
    : size.width < 44 ? "Narrow pane: labels clipped · arrows pan · +/- zoom · 0 reset · q quit"
    : "Keys: arrows pan · +/- zoom · 0 reset · q quit";
  const rows = [style(settings.color, "1;36", headerText), ...canvas.map((row) => renderCells(row, settings.color)), style(unsupported.length > 0 && settings.color, "31", clipDisplay(noticeText, size.width))];
  return { output: boundedOutput(rows.join("\n")), width: size.width, height: size.height, unsupported, elementCount: allElements.length, labelCount: labels.length };
}

export function renderTerminalFallback(scene: unknown, options: TerminalRenderOptions = {}): string {
  return renderExcalidrawAnsi(scene, options).output;
}
