import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startExcalidrawViewer, MAX_VIEWER_ELEMENTS, MAX_VIEWER_PAYLOAD_BYTES } from "./excalidraw-viewer-server.ts";

const scene = {
  type: "excalidraw",
  version: 2,
  elements: [{ id: "box", type: "rectangle", x: 0, y: 0, width: 10, height: 10, piUnknown: { retained: true } }],
  appState: { viewBackgroundColor: "#fff" },
  files: {
    first: { mimeType: "image/png", data: "one" },
    second: { mimeType: "image/png", data: "two" },
  },
  piTopLevelUnknown: "retained",
};

function sessionUrl(session: { url: string }, path: string): URL {
  const base = new URL(session.url);
  const target = new URL(path, base);
  target.search = "";
  if (target.pathname === "/viewer" || target.pathname === "/viewer/") {
    target.searchParams.set("token", base.searchParams.get("token") || "");
  }
  return target;
}

async function request(session: { url: string }, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", `pi_excalidraw_token=${new URL(session.url).searchParams.get("token") || ""}`);
  return fetch(sessionUrl(session, path), { ...init, headers });
}

async function testStaticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-excalidraw-viewer-static-"));
  await writeFile(join(root, "index.html"), "viewer", "utf8");
  return root;
}

test("viewer uses a random token, serves only the viewer root, and isolates paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-excalidraw-viewer-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "viewer", "utf8");
  await writeFile(join(root, "assets", "app.js"), "local", "utf8");
  const outside = await mkdtemp(join(tmpdir(), "pi-excalidraw-viewer-outside-"));
  await writeFile(join(outside, "escape.js"), "outside", "utf8");
  await symlink(join(outside, "escape.js"), join(root, "assets", "escape.js"));
  await writeFile(join(root, "secret.txt"), "secret", "utf8");
  const session = await startExcalidrawViewer(scene, { staticRoot: root });
  try {
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/viewer\/\?token=[0-9a-f]{64}$/);
    const index = await request(session, "/viewer/");
    assert.equal(index.status, 200);
    const cookie = index.headers.get("set-cookie");
    assert.match(cookie || "", /pi_excalidraw_token=/);
    const assetUrl = new URL("/viewer/assets/app.js", session.url);
    assetUrl.search = "";
    const assetWithoutQuery = await fetch(assetUrl, { headers: { cookie: cookie!.split(";", 1)[0] } });
    assert.equal(assetWithoutQuery.status, 200);
    assert.equal((await request(session, "/secret.txt")).status, 404);
    assert.equal((await request(session, "/viewer/../secret.txt")).status, 404);
    assert.equal((await request(session, "/viewer/assets/escape.js")).status, 404);
    assert.equal((await fetch(new URL("/api/scene", session.url))).status, 401);
    const wrongToken = new URL("/api/scene", session.url);
    wrongToken.searchParams.set("token", "wrong");
    assert.equal((await fetch(wrongToken)).status, 401);
  } finally {
    await session.close();
  }
});

test("viewer applies initial read-only policy before accepting requests", async () => {
  const session = await startExcalidrawViewer(scene, { staticRoot: await testStaticRoot(), writable: false });
  try {
    const current = await (await request(session, "/api/scene")).json() as { writable: boolean; revision: number };
    assert.equal(current.writable, false);
    const rejected = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: current.revision, scene }) });
    assert.equal(rejected.status, 403);
  } finally { await session.close(); }
});

test("viewer rejects stale writes and preserves unknown Excalidraw fields", async () => {
  const session = await startExcalidrawViewer(scene, { staticRoot: await testStaticRoot() });
  try {
    const initial = await request(session, "/api/scene");
    const value = await initial.json() as { scene: typeof scene; revision: number };
    assert.equal(value.revision, 1);
    assert.equal((value as any).writable, true);
    const accepted = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, scene: { type: "excalidraw", elements: [{ id: "box", type: "rectangle", x: 5 }], appState: {}, files: {} } }) });
    assert.equal(accepted.status, 200);
    assert.equal((await request(session, "/api/scene")).status, 200);
    const current = await (await request(session, "/api/scene")).json() as { scene: typeof scene; revision: number };
    assert.equal(current.revision, 2);
    assert.deepEqual((current.scene.elements[0] as any).piUnknown, { retained: true });
    assert.equal(current.scene.piTopLevelUnknown, "retained");
    assert.deepEqual(current.scene.files, scene.files);
    const firstClient = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 2, scene: { ...scene, elements: [{ id: "box", type: "rectangle", x: 7 }] } }) });
    assert.equal(firstClient.status, 200);
    const stale = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 2, scene }) });
    assert.equal(stale.status, 409);
  } finally {
    await session.close();
  }
});

test("partial file updates preserve existing embedded files while merging new IDs", async () => {
  const session = await startExcalidrawViewer(scene, { staticRoot: await testStaticRoot() });
  try {
    const response = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, scene: { type: "excalidraw", elements: scene.elements, files: { third: { mimeType: "image/png", data: "three" } } } }) });
    assert.equal(response.status, 200);
    const current = await (await request(session, "/api/scene")).json() as any;
    assert.deepEqual(current.scene.files, { ...scene.files, third: { mimeType: "image/png", data: "three" } });
  } finally {
    await session.close();
  }
});

test("read-only mode revokes an already-authenticated writer", async () => {
  const session = await startExcalidrawViewer(scene, { staticRoot: await testStaticRoot() });
  try {
    const accepted = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, scene }) });
    assert.equal(accepted.status, 200);
    session.setWritable(false);
    const rejected = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 2, scene }) });
    assert.equal(rejected.status, 403);
    assert.equal((await request(session, "/api/scene")).status, 200);
  } finally {
    await session.close();
  }
});

test("viewer bounds payloads and element counts", async () => {
  const session = await startExcalidrawViewer(scene, { staticRoot: await testStaticRoot() });
  try {
    const tooMany = { ...scene, elements: Array.from({ length: MAX_VIEWER_ELEMENTS + 1 }, (_, id) => ({ id: String(id) })) };
    const response = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, scene: tooMany }) });
    assert.equal(response.status, 422);
    const huge = { ...scene, elements: [{ id: "huge", text: "x".repeat(MAX_VIEWER_PAYLOAD_BYTES) }] };
    const bounded = await request(session, "/api/scene", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, scene: huge }) });
    assert.equal(bounded.status, 413);
  } finally {
    await session.close();
  }
});
