// pi's agent-dir resolution, in-process so pi-fovea modules never import the
// pi-coding-agent runtime at extension load. pi's loader re-evaluates the host
// module graph for every extension that imports it, costing roughly a second
// of startup.

import { homedir } from "node:os";
import path from "node:path";

export const configDirName = ".pi";

const expandTilde = (value: string): string => {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
};

export const resolveAgentDir = (): string => {
  const override = process.env.PI_CODING_AGENT_DIR;
  return override ? expandTilde(override) : path.join(homedir(), configDirName, "agent");
};
