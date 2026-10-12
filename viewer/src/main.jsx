import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./style.css";

const token = new URLSearchParams(window.location.search).get("token");
const sceneUrl = "/api/scene";

function App() {
  const [scene, setScene] = useState(null);
  const [revision, setRevision] = useState(0);
  const [writable, setWritable] = useState(true);
  const [status, setStatus] = useState("Loading scene…");
  const latestRevision = useRef(0);
  const currentScene = useRef(null);
  const excalidrawApi = useRef(null);
  const saveTimer = useRef(null);
  const saveQueue = useRef(Promise.resolve());
  const saveGeneration = useRef(0);

  const updateCanvas = useCallback((nextScene) => {
    if (!excalidrawApi.current) return;
    excalidrawApi.current.updateScene({
      elements: nextScene.elements,
      appState: nextScene.appState,
      files: nextScene.files,
    });
  }, []);

  const load = useCallback(async ({ preserveLocal = false } = {}) => {
    if (!token) throw new Error("This viewer URL is missing its session token.");
    const response = await fetch(sceneUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Scene request failed (${response.status}).`);
    const value = await response.json();
    latestRevision.current = value.revision;
    setRevision(value.revision);
    if (typeof value.writable === "boolean") setWritable(value.writable);
    if (!preserveLocal) {
      currentScene.current = value.scene;
      setScene(value.scene);
      updateCanvas(value.scene);
    }
    return value;
  }, [updateCanvas]);

  useEffect(() => {
    load().then(() => setStatus("Connected · local-only viewer")).catch((error) => setStatus(error.message));
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [load]);

  const saveOne = useCallback(async (nextScene, generation) => {
    const response = await fetch(sceneUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ revision: latestRevision.current, scene: nextScene }),
    });
    if (response.status === 409) {
      // Refresh only the server revision. Keep the local canvas and scene so a
      // conflict never discards edits that have not been acknowledged.
      await load({ preserveLocal: true });
      if (generation === saveGeneration.current) setStatus("Scene changed elsewhere · local changes kept");
      return;
    }
    if (response.status === 403) {
      setWritable(false);
      throw new Error("Read-only mode · browser edits are disabled");
    }
    if (!response.ok) throw new Error(`Scene save failed (${response.status}).`);
    const value = await response.json();
    latestRevision.current = value.revision;
    setRevision(value.revision);
    if (generation === saveGeneration.current) setStatus("Saved · local-only viewer");
  }, [load]);

  const queueSave = useCallback((nextScene, generation) => {
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(() => saveOne(nextScene, generation))
      .catch((error) => {
        if (generation === saveGeneration.current) setStatus(error.message);
      });
  }, [saveOne]);

  const save = useCallback((nextScene) => {
    currentScene.current = nextScene;
    setScene(nextScene);
    setStatus("Saving…");
    const generation = ++saveGeneration.current;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => queueSave(nextScene, generation), 250);
  }, [queueSave]);

  const onExcalidrawApi = useCallback((api) => {
    excalidrawApi.current = api;
    if (currentScene.current) updateCanvas(currentScene.current);
  }, [updateCanvas]);

  if (!scene) return <main className="loading"><h1>Pi Excalidraw viewer</h1><p>{status}</p></main>;
  return <main className="viewer">
    <header><strong>Pi Excalidraw</strong><span>{!writable && "Read-only · "}{status} · revision {revision}</span></header>
    <section className="canvas"><Excalidraw
      excalidrawAPI={onExcalidrawApi}
      initialData={{ ...scene, viewModeEnabled: !writable }}
      viewModeEnabled={!writable}
      onChange={(elements, appState, files) => { if (writable) save({ ...currentScene.current, elements, appState, files }); }}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
    /></section>
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
