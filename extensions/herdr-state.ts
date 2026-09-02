import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HERDR_STATE_VERSION = 3;
export type HerdrBindingRole = "generic-shell" | "notes-viewer";

export interface HerdrBinding {
  key: string;
  role: HerdrBindingRole;
  workspaceId: string;
  parentTabId?: string;
  paneId: string;
  terminalId?: string;
  cwd: string;
  lastCommand?: string;
  createdAt: string;
  updatedAt: string;
}

export class UnsupportedHerdrStateVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Herdr state version ${version} is newer than supported version ${HERDR_STATE_VERSION}; it was left unchanged.`);
    this.name = "UnsupportedHerdrStateVersionError";
    this.version = version;
  }
}

export const defaultHerdrStateFile = () => join(getAgentDir(), "herdr-shell.json");
const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const STALE_LOCK_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBinding(value: unknown): value is HerdrBinding {
  if (!isRecord(value)) return false;
  return ["key", "workspaceId", "paneId", "cwd", "createdAt", "updatedAt"].every((key) => typeof value[key] === "string") &&
    (value.role === "generic-shell" || value.role === "notes-viewer");
}

type DecodedState =
  | { kind: "bindings"; bindings: HerdrBinding[] }
  | { kind: "malformed" }
  | { kind: "newer"; version: number };

function decode(value: unknown): DecodedState {
  if (!isRecord(value) || !Array.isArray(value.bindings) || typeof value.version !== "number") return { kind: "malformed" };
  if (value.version > HERDR_STATE_VERSION) return { kind: "newer", version: value.version };
  if (value.version === HERDR_STATE_VERSION) {
    return value.bindings.every(isBinding) ? { kind: "bindings", bindings: value.bindings } : { kind: "malformed" };
  }
  // Version 2 only owned generic command panes. Retain only complete records.
  if (value.version === 2) {
    const legacy = value.bindings.filter((binding): binding is Record<string, unknown> => isRecord(binding) &&
      ["key", "workspaceId", "paneId", "cwd", "createdAt", "updatedAt"].every((key) => typeof binding[key] === "string"));
    if (legacy.length !== value.bindings.length) return { kind: "malformed" };
    return {
      kind: "bindings",
      bindings: legacy.map((binding) => ({
        ...binding,
        key: String(binding.key).startsWith("generic-shell|") ? binding.key : `generic-shell|${binding.key}`,
        role: "generic-shell",
      }) as HerdrBinding),
    };
  }
  return { kind: "malformed" };
}

/** Called while the state lock is held, so a valid writer cannot be renamed. */
async function quarantineMalformed(file: string): Promise<void> {
  const replacement = `${file}.invalid-${Date.now()}-${process.pid}-${randomUUID()}`;
  try { await fs.rename(file, replacement); } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function load(file: string, quarantine: boolean): Promise<Map<string, HerdrBinding>> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return new Map();
    throw error;
  }
  let decoded: DecodedState;
  try { decoded = decode(JSON.parse(raw)); }
  catch { decoded = { kind: "malformed" }; }
  if (decoded.kind === "newer") throw new UnsupportedHerdrStateVersionError(decoded.version);
  if (decoded.kind === "malformed") {
    if (quarantine) await quarantineMalformed(file);
    return new Map();
  }
  return new Map(decoded.bindings.map((binding) => [binding.key, binding]));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function ownerIsAlive(pid: unknown): Promise<boolean> {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user: never steal it.
    if (isRecord(error) && error.code === "EPERM") return true;
    return !(isRecord(error) && error.code === "ESRCH");
  }
}

/** Atomically detach a stale lock before deleting it; never rm the live lock path. */
async function reclaimLock(lock: string): Promise<void> {
  const detached = `${lock}.stale-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(lock, detached);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  await fs.rm(detached, { recursive: true, force: true });
}

async function staleLock(lock: string): Promise<boolean> {
  let entry;
  try { entry = await fs.lstat(lock); }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
  if (!entry.isDirectory()) return false;
  try {
    const owner = JSON.parse(await fs.readFile(join(lock, "owner.json"), "utf8")) as { pid?: unknown; createdAt?: unknown };
    const createdAt = typeof owner.createdAt === "number" ? owner.createdAt : entry.mtimeMs;
    return Date.now() - createdAt > STALE_LOCK_MS && !await ownerIsAlive(owner.pid);
  } catch (error) {
    // A crash after mkdir but before owner.json (or while writing it) must be
    // recoverable. Permission failures remain conservative and are never
    // interpreted as a dead owner.
    if (isRecord(error) && (error.code === "EACCES" || error.code === "EPERM")) return false;
    return Date.now() - entry.mtimeMs > INCOMPLETE_LOCK_GRACE_MS;
  }
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      const token = randomUUID();
      const ownerPath = join(lock, "owner.json");
      try {
        await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), { mode: 0o600 });
      } catch (error) {
        // Only remove the owner file we just attempted to create; rmdir cannot
        // remove a recreated/non-empty lock directory.
        await fs.rm(ownerPath, { force: true }).catch(() => undefined);
        await fs.rmdir(lock).catch(() => undefined);
        throw error;
      }
      return async () => {
        try {
          const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as { token?: unknown };
          if (owner.token !== token) return;
          await fs.unlink(ownerPath);
          // rmdir is intentionally non-recursive: it cannot delete a lock a
          // different process recreated after ours was released.
          await fs.rmdir(lock);
        } catch { /* lock was reclaimed or replaced; never delete recursively */ }
      };
    } catch (error) {
      if (!(isRecord(error) && error.code === "EEXIST")) throw error;
      if (await staleLock(lock)) await reclaimLock(lock);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the Herdr state lock: ${basename(lock)}`);
      await delay(40 + Math.floor(Math.random() * 40));
    }
  }
}

async function atomicWrite(file: string, bindings: Map<string, HerdrBinding>): Promise<void> {
  const state = { version: HERDR_STATE_VERSION, bindings: [...bindings.values()] };
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Reads and quarantine decisions are serialized with writers. */
export async function readHerdrBindings(file = defaultHerdrStateFile()): Promise<Map<string, HerdrBinding>> {
  const release = await acquireLock(file);
  try { return await load(file, true); }
  finally { await release(); }
}

/** Locked cross-process read-modify-write. The callback must only mutate its map. */
export async function updateHerdrBindings<T>(
  mutate: (bindings: Map<string, HerdrBinding>) => T | Promise<T>,
  file = defaultHerdrStateFile(),
): Promise<T> {
  const release = await acquireLock(file);
  try {
    const bindings = await load(file, true);
    // Reconciliation often proves that every record is still current. Do not
    // replace the state file in that case: an unnecessary rename can race
    // external observers and makes a no-op look like a new binding write.
    const before = JSON.stringify([...bindings.values()]);
    const result = await mutate(bindings);
    if (JSON.stringify([...bindings.values()]) !== before) await atomicWrite(file, bindings);
    return result;
  } finally {
    await release();
  }
}

export async function upsertHerdrBinding(binding: HerdrBinding, file = defaultHerdrStateFile()): Promise<void> {
  await updateHerdrBindings((bindings) => { bindings.set(binding.key, binding); }, file);
}

export async function removeHerdrBinding(key: string, paneId?: string, file = defaultHerdrStateFile()): Promise<void> {
  await updateHerdrBindings((bindings) => {
    const current = bindings.get(key);
    if (current && (!paneId || current.paneId === paneId)) bindings.delete(key);
  }, file);
}
