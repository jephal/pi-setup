import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}
const report = JSON.parse(result.stdout);
const files = new Set(report[0]?.files?.map((entry) => entry.path) || []);
for (const required of ["viewer/dist/index.html", "THIRD-PARTY-NOTICES"]) {
  if (!files.has(required)) throw new Error(`npm pack --dry-run omitted ${required}`);
}
const bundleFiles = [...files].filter((file) => file.startsWith("viewer/dist/"));
if (bundleFiles.length < 2) throw new Error("npm pack --dry-run did not include the generated viewer assets");
for (const required of ["extensions/excalidraw-terminal-viewer.ts", "extensions/excalidraw-terminal-renderer.ts"]) {
  if (!files.has(required)) throw new Error(`npm pack --dry-run omitted ${required}`);
}
const packageJson = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8")));
if (packageJson.engines?.node !== ">=22.6.0") throw new Error("package engine must declare Node >=22.6.0 for --experimental-strip-types");
const check = spawnSync(process.execPath, ["--experimental-strip-types", "--check", "extensions/excalidraw-terminal-viewer.ts"], { encoding: "utf8" });
if (check.status !== 0) throw new Error(`packed viewer entrypoint is not launchable under this Node: ${check.stderr || check.stdout}`);
console.log(`Package check passed: ${bundleFiles.length} viewer bundle files, terminal entrypoints, and THIRD-PARTY-NOTICES are included.`);
