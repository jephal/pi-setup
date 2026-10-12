/** Shared request-shape classification used by execution and approval policy. */
export type VisualizationRequestClass =
  | "preview-mermaid"
  | "preview-excalidraw"
  | "browser-viewer"
  | "terminal-viewer"
  | "artifact";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Classify the public visualization variants without accepting a preview-shaped
 * request that secretly targets a viewer or artifact. Detailed limits and field
 * validation remain in visualization.ts.
 */
export function classifyVisualizationRequest(value: unknown): VisualizationRequestClass | undefined {
  if (!record(value)) return undefined;
  const action = value.action;
  const format = value.format;
  const target = value.target;
  if (action === "preview" && target === undefined && format === "mermaid" && typeof value.source === "string") return "preview-mermaid";
  if (action === "preview" && (target === undefined || target === "plan_board") && format === "excalidraw" && Array.isArray(value.nodes) && value.nodes.length > 0) return "preview-excalidraw";
  if (action === "viewer" && format === "excalidraw" && target === "terminal_viewer" && Array.isArray(value.nodes) && value.nodes.length > 0) return "terminal-viewer";
  if (action === "viewer" && format === "excalidraw" && target === undefined && Array.isArray(value.nodes) && value.nodes.length > 0) return "browser-viewer";
  if (action === "terminal_viewer" && format === "excalidraw" && (target === "open" || target === "update" || target === "status" || target === "close")) return "terminal-viewer";
  if (action === "artifact" && format === "excalidraw" && target === undefined && Array.isArray(value.nodes) && value.nodes.length > 0 && typeof value.path === "string") return "artifact";
  return undefined;
}

export function isPreviewVisualizationRequest(value: unknown): boolean {
  const kind = classifyVisualizationRequest(value);
  return kind === "preview-mermaid" || kind === "preview-excalidraw";
}
