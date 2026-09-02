import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Request names accepted by `events.subscribe`. */
export const HERDR_SUBSCRIPTION_TYPES = ["pane.closed", "pane.exited", "pane.moved", "tab.closed", "workspace.closed"] as const;
export type HerdrSubscriptionType = typeof HERDR_SUBSCRIPTION_TYPES[number];

/** Event names emitted in the socket's NDJSON envelopes. */
export const HERDR_EMITTED_EVENT_TYPES = ["pane_closed", "pane_exited", "pane_moved", "tab_closed", "workspace_closed"] as const;
export type HerdrEmittedEventType = typeof HERDR_EMITTED_EVENT_TYPES[number];

const emittedToLifecycle = {
  pane_closed: "pane.closed",
  pane_exited: "pane.exited",
  pane_moved: "pane.moved",
  tab_closed: "tab.closed",
  workspace_closed: "workspace.closed",
} as const satisfies Record<HerdrEmittedEventType, HerdrSubscriptionType>;

export interface HerdrEventEnvelope {
  /** Normalized lifecycle type used by the pane manager. */
  event: HerdrSubscriptionType;
  data: Record<string, unknown>;
}

export type HerdrSubscriptionMessage =
  | { kind: "acknowledged" }
  | { kind: "error"; error: string }
  | { kind: "event"; event: HerdrEventEnvelope }
  | { kind: "ignored" };

export function resolveHerdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return env.HERDR_SESSION
    ? join(configHome, "herdr", "sessions", env.HERDR_SESSION, "herdr.sock")
    : join(configHome, "herdr", "herdr.sock");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse subscription control messages separately from the snake_case event stream. */
export function parseHerdrSubscriptionMessage(line: string): HerdrSubscriptionMessage {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) return { kind: "ignored" };
    const emitted = value.event;
    if (typeof emitted === "string" && emitted in emittedToLifecycle && isRecord(value.data)) {
      return { kind: "event", event: { event: emittedToLifecycle[emitted as HerdrEmittedEventType], data: value.data } };
    }
    if (isRecord(value.error)) {
      const error = typeof value.error.message === "string" ? value.error.message : "Herdr event subscription failed.";
      return { kind: "error", error };
    }
    const result = isRecord(value.result) ? value.result : undefined;
    if (result && (result.type === "subscription_started" || result.subscribed === true)) return { kind: "acknowledged" };
    return { kind: "ignored" };
  } catch {
    return { kind: "ignored" };
  }
}

/** Backward-compatible event-only view of a raw NDJSON line. */
export function parseHerdrEventLine(line: string): HerdrEventEnvelope | undefined {
  const message = parseHerdrSubscriptionMessage(line);
  return message.kind === "event" ? message.event : undefined;
}

export interface HerdrEventSubscriberOptions {
  socketPath?: string;
  onEvent: (event: HerdrEventEnvelope) => void;
  /** Called only after Herdr acknowledges the subscription or rejects it. */
  onStatus?: (status: "subscribed" | "error", error?: string) => void;
  reconnectMs?: number;
  maxReconnectMs?: number;
  maxBufferBytes?: number;
}

/** Optional, unref'd NDJSON Unix-socket subscriber; CLI polling remains the fallback. */
export class HerdrEventSubscriber {
  private socket: net.Socket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private buffer = "";
  private reconnectAttempt = 0;
  private readonly socketPath: string;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly maxBufferBytes: number;
  private readonly options: HerdrEventSubscriberOptions;

  constructor(options: HerdrEventSubscriberOptions) {
    this.options = options;
    this.socketPath = options.socketPath ?? resolveHerdrSocketPath();
    this.reconnectMs = Math.max(10, options.reconnectMs ?? 2_000);
    this.maxReconnectMs = Math.max(this.reconnectMs, options.maxReconnectMs ?? 30_000);
    this.maxBufferBytes = Math.max(1_024, options.maxBufferBytes ?? 64 * 1024);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = "";
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = net.createConnection({ path: this.socketPath });
    socket.unref();
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        id: `pi-herdr-events-${process.pid}-${Date.now()}`,
        method: "events.subscribe",
        params: { subscriptions: HERDR_SUBSCRIPTION_TYPES.map((type) => ({ type })) },
      })}\n`);
    });
    socket.on("data", (chunk: string) => this.onData(socket, chunk));
    socket.once("error", () => { /* close schedules a bounded reconnect */ });
    socket.once("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.scheduleReconnect();
    });
  }

  private onData(socket: net.Socket, chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferBytes) {
      this.buffer = "";
      socket.destroy();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const message = parseHerdrSubscriptionMessage(line);
      if (message.kind === "acknowledged") {
        this.reconnectAttempt = 0;
        this.options.onStatus?.("subscribed");
      } else if (message.kind === "error") {
        this.options.onStatus?.("error", message.error);
        socket.destroy();
      } else if (message.kind === "event") {
        this.options.onEvent(message.event);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.maxReconnectMs, this.reconnectMs * 2 ** Math.min(this.reconnectAttempt++, 8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
}
