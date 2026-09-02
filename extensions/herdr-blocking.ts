import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type HerdrEventBus = Pick<ExtensionAPI, "events">;

/** Tell Herdr that a Pi extension is waiting for an explicit human decision.
 * The official integration reference-counts active blockers, so every activation
 * is paired with one deactivation even when another dialog is nested inside it.
 * The event is harmless in headless sessions and when the integration is absent.
 */
export async function withHerdrBlock<T>(
  pi: HerdrEventBus,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  pi.events.emit("herdr:blocked", { active: true, label });
  try {
    return await operation();
  } finally {
    pi.events.emit("herdr:blocked", { active: false, label });
  }
}
