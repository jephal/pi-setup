import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHerdrBindings, UnsupportedHerdrStateVersionError, updateHerdrBindings } from "./herdr-state.ts";

function binding(key: string, role: "generic-shell" | "notes-viewer" = "generic-shell") {
  return { key, role, workspaceId: "w1", parentTabId: "w1:t1", paneId: `w1:${key}`, terminalId: `term-${key}`, cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("migrates v2 shell records and preserves explicit role separation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-state-"));
  const file = join(directory, "state.json");
  try {
    await writeFile(file, JSON.stringify({ version: 2, bindings: [{ ...binding("old"), role: undefined }] }));
    const bindings = await readHerdrBindings(file);
    assert.equal(bindings.get("generic-shell|old")?.role, "generic-shell");
    await updateHerdrBindings((records) => { records.set("notes", binding("notes", "notes-viewer")); }, file);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.version, 3);
    assert.deepEqual(saved.bindings.map((entry: { role: string }) => entry.role).sort(), ["generic-shell", "notes-viewer"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("quarantines malformed state and performs locked concurrent read-modify-write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-state-"));
  const file = join(directory, "state.json");
  try {
    await writeFile(file, "{broken");
    assert.equal((await readHerdrBindings(file)).size, 0);
    await Promise.all(Array.from({ length: 12 }, (_, index) => updateHerdrBindings((records) => {
      records.set(`key-${index}`, binding(`key-${index}`));
    }, file)));
    const bindings = await readHerdrBindings(file);
    assert.equal(bindings.size, 12);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not rewrite state for a no-op update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-state-"));
  const file = join(directory, "state.json");
  try {
    await updateHerdrBindings((records) => { records.set("kept", binding("kept")); }, file);
    const before = await stat(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await updateHerdrBindings(() => undefined, file);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reclaims an abandoned mkdir lock with no owner metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-state-"));
  const file = join(directory, "state.json");
  const lock = `${file}.lock`;
  try {
    await mkdir(lock);
    const old = new Date(Date.now() - 31_000);
    await utimes(lock, old, old);
    await updateHerdrBindings((records) => { records.set("recovered", binding("recovered")); }, file);
    assert.equal((await readHerdrBindings(file)).get("recovered")?.paneId, "w1:recovered");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("leaves unknown newer state versions untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-state-"));
  const file = join(directory, "state.json");
  const newer = { version: 99, bindings: [{ anything: "future" }], futureField: true };
  try {
    await writeFile(file, JSON.stringify(newer));
    await assert.rejects(readHerdrBindings(file), UnsupportedHerdrStateVersionError);
    await assert.rejects(updateHerdrBindings(() => undefined, file), UnsupportedHerdrStateVersionError);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), newer);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
