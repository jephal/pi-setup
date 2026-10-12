import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const CONTEXT_LIMIT_TOKENS = 500_000;
export const RESPONSE_RESERVE_TOKENS = 16_384;
export const CAPPED_CONTEXT_WINDOW_TOKENS = CONTEXT_LIMIT_TOKENS + RESPONSE_RESERVE_TOKENS;
export const PROVIDER_ID = "github-copilot";

// Current GitHub Copilot catalog models advertising context windows above 500k.
// Keep this list aligned with the catalog; smaller-context models are untouched.
export const LARGE_CONTEXT_MODEL_IDS = [
  "claude-haiku-5.5",
  "claude-opus-4.8",
  "claude-opus-5",
  "claude-opus-5.5",
  "claude-sonnet-5",
  "claude-sonnet-5.5",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "kimi-k3",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, description) {
  if (!isRecord(value)) throw new Error(`${description} must be a JSON object`);
  return value;
}

function getOrCreateRecord(parent, key, description) {
  if (parent[key] === undefined) parent[key] = {};
  return requireRecord(parent[key], description);
}

export function applyModelContextCap(config) {
  const result = structuredClone(requireRecord(config, "models.json"));
  const providers = getOrCreateRecord(result, "providers", "models.json providers");
  const provider = getOrCreateRecord(providers, PROVIDER_ID, `${PROVIDER_ID} provider`);
  const overrides = getOrCreateRecord(provider, "modelOverrides", `${PROVIDER_ID} modelOverrides`);

  for (const modelId of LARGE_CONTEXT_MODEL_IDS) {
    const override = getOrCreateRecord(overrides, modelId, `${PROVIDER_ID}/${modelId} model override`);
    override.contextWindow = CAPPED_CONTEXT_WINDOW_TOKENS;
  }

  return result;
}

export function applyCompactionCap(config) {
  const result = structuredClone(requireRecord(config, "settings.json"));
  const compaction = getOrCreateRecord(result, "compaction", "settings.json compaction");
  compaction.enabled = true;
  const overrides = getOrCreateRecord(compaction, "modelOverrides", "compaction modelOverrides");

  for (const modelId of LARGE_CONTEXT_MODEL_IDS) {
    const key = `${PROVIDER_ID}/${modelId}`;
    const override = getOrCreateRecord(overrides, key, `${key} compaction override`);
    override.reserveTokens = RESPONSE_RESERVE_TOKENS;
  }

  return result;
}

function readConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${error.message}`);
  }
  return requireRecord(parsed, filePath);
}

function writeConfig(filePath, config) {
  const next = `${JSON.stringify(config, null, 2)}\n`;
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  if (current === next) return false;
  fs.writeFileSync(filePath, next, { encoding: "utf8", mode: 0o600 });
  return true;
}

export function configureContextCap({ agentDir = path.join(homedir(), ".pi", "agent"), dryRun = false } = {}) {
  const settingsPath = path.join(agentDir, "settings.json");
  const modelsPath = path.join(agentDir, "models.json");

  // Read and validate both files before changing either one.
  const nextSettings = applyCompactionCap(readConfig(settingsPath));
  const nextModels = applyModelContextCap(readConfig(modelsPath));
  if (dryRun) {
    return { changedFiles: [settingsPath, modelsPath], modelCount: LARGE_CONTEXT_MODEL_IDS.length };
  }

  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const changedFiles = [];
  if (writeConfig(settingsPath, nextSettings)) changedFiles.push(settingsPath);
  if (writeConfig(modelsPath, nextModels)) changedFiles.push(modelsPath);
  return { changedFiles, modelCount: LARGE_CONTEXT_MODEL_IDS.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = configureContextCap({ dryRun: process.argv.includes("--dry-run") });
    if (process.argv.includes("--dry-run")) {
      console.log(`Would configure a 500,000-token auto-compaction threshold for ${result.modelCount} large-context GitHub Copilot models.`);
    } else {
      console.log(`Configured a 500,000-token auto-compaction threshold for ${result.modelCount} large-context GitHub Copilot models.`);
      if (result.changedFiles.length) console.log(`Updated: ${result.changedFiles.join(", ")}`);
      else console.log("Pi settings already match the cap; no files changed.");
      console.log("Restart Pi to load the model context-window overrides.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
