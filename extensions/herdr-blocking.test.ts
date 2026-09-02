import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withHerdrBlock } from "./herdr-blocking.ts";

type Event = { name: string; data: unknown };

function fakePi(events: Event[]): Pick<ExtensionAPI, "events"> {
  return {
    events: {
      emit(name: string, data: unknown) {
        events.push({ name, data });
      },
    },
  } as Pick<ExtensionAPI, "events">;
}

test("reports and clears a Herdr blocker around a successful operation", async () => {
  const events: Event[] = [];
  const result = await withHerdrBlock(fakePi(events), "Waiting for approval", async () => "approved");

  assert.equal(result, "approved");
  assert.deepEqual(events, [
    { name: "herdr:blocked", data: { active: true, label: "Waiting for approval" } },
    { name: "herdr:blocked", data: { active: false, label: "Waiting for approval" } },
  ]);
});

test("clears a Herdr blocker when the operation rejects", async () => {
  const events: Event[] = [];
  const failure = new Error("cancelled");

  await assert.rejects(
    withHerdrBlock(fakePi(events), "Waiting for your answers", async () => {
      throw failure;
    }),
    failure,
  );

  assert.deepEqual(events, [
    { name: "herdr:blocked", data: { active: true, label: "Waiting for your answers" } },
    { name: "herdr:blocked", data: { active: false, label: "Waiting for your answers" } },
  ]);
});

test("preserves activation order for nested blockers", async () => {
  const events: Event[] = [];
  const pi = fakePi(events);

  await withHerdrBlock(pi, "Waiting for plan review", async () =>
    withHerdrBlock(pi, "Waiting for plan edits", async () => undefined),
  );

  assert.deepEqual(events, [
    { name: "herdr:blocked", data: { active: true, label: "Waiting for plan review" } },
    { name: "herdr:blocked", data: { active: true, label: "Waiting for plan edits" } },
    { name: "herdr:blocked", data: { active: false, label: "Waiting for plan edits" } },
    { name: "herdr:blocked", data: { active: false, label: "Waiting for plan review" } },
  ]);
});
