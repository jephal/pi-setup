/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	truncateHead,
	truncateTail,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	createMcpForwardingBridge,
	getMcpForwardingProvider,
	type McpForwardingBridge,
} from "../mcp-forwarding.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = MAX_PARALLEL_TASKS;
const MAX_CONCURRENCY = 4;
// Final answers and chain handoffs retain enough leading context to remain useful.
const FINAL_OUTPUT_BYTES = 12 * 1024;
const FINAL_OUTPUT_LINES = 160;
// Stderr is diagnostic output, so retain its most recent portion instead.
const PER_TASK_STDERR_BYTES = 2 * 1024;
const PER_TASK_STDERR_LINES = 20;
const TASK_BYTES = 2 * 1024;
const TASK_LINES = 20;

/** Default workers get only the file and shell tools needed to complete local work. */
const DEFAULT_CHILD_TOOL_ALLOWLIST = ["read", "bash", "write", "edit", "find", "grep", "ls"] as const;
/** Explicit frontmatter may opt into these additional, still child-safe capabilities. */
const SAFE_CHILD_TOOL_ALLOWLIST = [
	...DEFAULT_CHILD_TOOL_ALLOWLIST, "ask_questions", "datadog_search_tools",
	"fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact", "herdr_shell",
] as const;
const SAFE_CHILD_TOOLS = new Set<string>(SAFE_CHILD_TOOL_ALLOWLIST);
const RECOVERY_DIRECTORIES = new Set<string>();
const BUNDLED_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents");

/** Install only missing bundled defaults; never overwrite a user's agent. */
async function installBundledAgents(): Promise<void> {
	const targetDir = path.join(getAgentDir(), "agents");
	await fs.promises.mkdir(targetDir, { recursive: true });
	const entries = await fs.promises.readdir(BUNDLED_AGENTS_DIR, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const target = path.join(targetDir, entry.name);
		try {
			await fs.promises.access(target);
			continue;
		} catch {
			// Missing default: install it below.
		}
		try {
			await fs.promises.copyFile(path.join(BUNDLED_AGENTS_DIR, entry.name), target, fs.constants.COPYFILE_EXCL);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	} | undefined,
	model?: string,
): string {
	const stats = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const parts: string[] = [];
	if (stats.turns) parts.push(`${stats.turns} turn${stats.turns > 1 ? "s" : ""}`);
	if (stats.input) parts.push(`↑${formatTokens(stats.input)}`);
	if (stats.output) parts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cacheRead) parts.push(`R${formatTokens(stats.cacheRead)}`);
	if (stats.cacheWrite) parts.push(`W${formatTokens(stats.cacheWrite)}`);
	if (stats.cost) parts.push(`$${stats.cost.toFixed(4)}`);
	if (stats.contextTokens && stats.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(stats.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	/** Internal-only JSON event history; never persisted in tool details. */
	messages: Message[];
	stderr: string;
	output?: string;
	outputTruncation?: BoundedText;
	stderrTruncation?: BoundedText;
	recoveryPath?: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface BoundedText {
	text: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
	truncatedBy: "lines" | "bytes" | null;
}

interface TruncationMetadata {
	truncated: true;
	totalBytes: number;
	totalLines: number;
	truncatedBy: "lines" | "bytes" | null;
}

interface CompactResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	outputTruncation?: TruncationMetadata;
	stderrTruncation?: TruncationMetadata;
	recoveryPath?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: CompactResult[];
}

export function sanitizeText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function boundText(value: string, maxBytes: number, maxLines: number): BoundedText {
	const truncated = truncateTail(sanitizeText(value), { maxBytes, maxLines });
	return {
		text: truncated.content,
		truncated: truncated.truncated,
		totalBytes: truncated.totalBytes,
		totalLines: truncated.totalLines,
		truncatedBy: truncated.truncatedBy,
	};
}

export function boundHeadText(value: string, maxBytes: number, maxLines: number): BoundedText {
	const sanitized = sanitizeText(value);
	const truncated = truncateHead(sanitized, { maxBytes, maxLines });
	// truncateHead deliberately avoids partial lines, but final agent output may
	// be one long JSON/text line. Retain a UTF-8-safe beginning in that case.
	let text = truncated.content;
	if (truncated.firstLineExceedsLimit) {
		let bytes = 0;
		text = "";
		for (const character of sanitized) {
			const characterBytes = Buffer.byteLength(character, "utf8");
			if (bytes + characterBytes > maxBytes) break;
			text += character;
			bytes += characterBytes;
		}
	}
	return {
		text,
		truncated: truncated.truncated,
		totalBytes: truncated.totalBytes,
		totalLines: truncated.totalLines,
		truncatedBy: truncated.truncatedBy,
	};
}

function truncationMarker(
	truncation: BoundedText,
	retained: "first" | "last",
	maxBytes: number,
	maxLines: number,
	recoveryPath?: string,
): string {
	if (!truncation.truncated) return "";
	const direction = retained === "first" ? "beginning" : "tail";
	const recovery = recoveryPath ? ` Recovery file is available only until session shutdown: ${recoveryPath}` : "";
	return `\n\n[Output truncated by ${truncation.truncatedBy ?? "limit"}: retained ${direction} (${maxBytes} bytes / ${maxLines} lines); total ${truncation.totalBytes} bytes / ${truncation.totalLines} lines.${recovery}]`;
}

function truncationMetadata(truncation: BoundedText): TruncationMetadata {
	return {
		truncated: true,
		totalBytes: truncation.totalBytes,
		totalLines: truncation.totalLines,
		truncatedBy: truncation.truncatedBy,
	};
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const textParts = msg.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text");
		if (textParts.length > 0) return textParts.map((part) => part.text).join("");
	}
	return "";
}

export function isFailedResult(result: Pick<SingleResult, "exitCode" | "stopReason">): boolean {
	return result.exitCode !== -1 && (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
}

function getResultOutput(result: SingleResult): string {
	const finalOutput = getFinalOutput(result.messages);
	if (result.exitCode === -1) return finalOutput;
	if (!isFailedResult(result)) return finalOutput || "(no output)";
	return [result.errorMessage, result.stderr, finalOutput].filter(Boolean).join("\n\n") || "(no output)";
}

export function childToolNames(agent: AgentConfig): string[] {
	const requested = agent.tools?.length ? agent.tools : DEFAULT_CHILD_TOOL_ALLOWLIST;
	return [...new Set(requested.filter((tool) => SAFE_CHILD_TOOLS.has(tool)))];
}

export function unsupportedChildToolNames(agent: AgentConfig): string[] {
	return [...new Set((agent.tools ?? []).filter((tool) => !SAFE_CHILD_TOOLS.has(tool)))];
}

/** Builds child CLI arguments while retaining the parent model and thinking defaults. */
export function buildChildArgs(
	agent: Pick<AgentConfig, "model">,
	parentCtx: Pick<ExtensionContext, "model" | "thinkingLevel">,
): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) {
		args.push("--model", agent.model);
	} else if (parentCtx.model) {
		args.push("--model", `${parentCtx.model.provider}/${parentCtx.model.id}`);
		if (parentCtx.thinkingLevel) args.push("--thinking", parentCtx.thinkingLevel);
	}
	return args;
}

/** Bridge-provided remote names may be registered by the loader later, but must not be pre-registered. */
export function childProcessToolNames(localToolNames: readonly string[], forwardedToolNames: readonly string[] = []): string[] {
	return [...new Set([...localToolNames, ...forwardedToolNames])];
}

async function writeRecoveryArtifact(agentName: string, output: string): Promise<string | undefined> {
	try {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-output-"));
		await fs.promises.chmod(dir, 0o700);
		RECOVERY_DIRECTORIES.add(dir);
		const filePath = path.join(dir, `${agentName.replace(/[^\w.-]+/g, "_")}-final.txt`);
		await fs.promises.writeFile(filePath, output, { encoding: "utf8", mode: 0o600 });
		await fs.promises.chmod(filePath, 0o600);
		return filePath;
	} catch {
		return undefined;
	}
}

async function finalizeResult(result: SingleResult): Promise<void> {
	const fullOutput = sanitizeText(getResultOutput(result));
	const outputTruncation = boundHeadText(fullOutput, FINAL_OUTPUT_BYTES, FINAL_OUTPUT_LINES);
	const recoveryPath = outputTruncation.truncated ? await writeRecoveryArtifact(result.agent, fullOutput) : undefined;
	result.output = `${outputTruncation.text}${truncationMarker(outputTruncation, "first", FINAL_OUTPUT_BYTES, FINAL_OUTPUT_LINES, recoveryPath)}`;
	result.outputTruncation = outputTruncation;
	result.recoveryPath = recoveryPath;
	const stderrTruncation = boundText(result.stderr, PER_TASK_STDERR_BYTES, PER_TASK_STDERR_LINES);
	result.stderr = `${stderrTruncation.text}${truncationMarker(stderrTruncation, "last", PER_TASK_STDERR_BYTES, PER_TASK_STDERR_LINES)}`;
	result.stderrTruncation = stderrTruncation;
}

export function compactResult(result: SingleResult): CompactResult {
	const outputTruncation = result.outputTruncation ?? boundHeadText(getResultOutput(result), FINAL_OUTPUT_BYTES, FINAL_OUTPUT_LINES);
	const stderrTruncation = result.stderrTruncation ?? boundText(result.stderr, PER_TASK_STDERR_BYTES, PER_TASK_STDERR_LINES);
	return {
		agent: sanitizeText(result.agent),
		agentSource: result.agentSource,
		task: boundHeadText(result.task, TASK_BYTES, TASK_LINES).text,
		exitCode: result.exitCode,
		output: result.output ?? `${outputTruncation.text}${truncationMarker(outputTruncation, "first", FINAL_OUTPUT_BYTES, FINAL_OUTPUT_LINES, result.recoveryPath)}`,
		stderr: result.stderrTruncation
			? result.stderr
			: `${stderrTruncation.text}${truncationMarker(stderrTruncation, "last", PER_TASK_STDERR_BYTES, PER_TASK_STDERR_LINES)}`,
		usage: result.usage,
		...(result.model ? { model: sanitizeText(result.model) } : {}),
		...(result.stopReason ? { stopReason: sanitizeText(result.stopReason) } : {}),
		...(result.errorMessage ? { errorMessage: boundText(result.errorMessage, PER_TASK_STDERR_BYTES, PER_TASK_STDERR_LINES).text } : {}),
		...(result.step !== undefined ? { step: result.step } : {}),
		...(outputTruncation.truncated ? { outputTruncation: truncationMetadata(outputTruncation) } : {}),
		...(stderrTruncation.truncated ? { stderrTruncation: truncationMetadata(stderrTruncation) } : {}),
		...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
	};
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (result: SingleResult) => void;

async function runSingleAgent(
	defaultCwd: string,
	parentCtx: ExtensionContext,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args = buildChildArgs(agent, parentCtx);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let forwardingBridge: McpForwardingBridge | undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1, // -1 = still running; never render a normal child as completed before it exits.
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => onUpdate?.(currentResult);
	if (signal?.aborted) {
		currentResult.exitCode = 1;
		currentResult.errorMessage = "Subagent was aborted";
		return currentResult;
	}

	try {
		const unsupportedTools = unsupportedChildToolNames(agent);
		if (unsupportedTools.length > 0) {
			// Preserve partially compatible user agents: run with their safe subset
			// instead of rejecting the entire agent configuration.
			currentResult.stderr = `Ignoring tools that are not child-safe: ${unsupportedTools.join(", ")}.`;
		}
		const toolNames = childToolNames(agent);
		if (toolNames.length === 0) {
			currentResult.exitCode = 1;
			currentResult.errorMessage = "The agent has no child-safe tools configured.";
			return currentResult;
		}
		// Datadog is an explicit frontmatter opt-in. Workers with no tools never
		// connect to it; forwarded remote tools are never pre-activated.
		const requiresDatadogForwarding = toolNames.includes("datadog_search_tools");
		const forwardingProvider = requiresDatadogForwarding ? getMcpForwardingProvider() : undefined;
		if (requiresDatadogForwarding && !forwardingProvider) {
			currentResult.exitCode = 1;
			currentResult.errorMessage = "Datadog MCP forwarding is unavailable in the parent session.";
			return currentResult;
		}
		if (forwardingProvider) {
			try {
				forwardingBridge = await createMcpForwardingBridge(forwardingProvider, parentCtx, signal);
			} catch (error) {
				currentResult.exitCode = 1;
				currentResult.errorMessage = error instanceof Error ? error.message : String(error);
				return currentResult;
			}
		}

		// The bridge passes allowed remote names so the child can use a tool after
		// datadog_search_tools registers it on demand. Do not pre-register remote
		// tools: Pi activates allowlisted registered tools in the child prompt.
		args.push("--tools", childProcessToolNames(toolNames, forwardingBridge?.toolNames).join(","));

		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const childEnv = { ...process.env };
			if (forwardingBridge) Object.assign(childEnv, forwardingBridge.env);
			else {
				delete childEnv.PI_MCP_FORWARD_SOCKET;
				delete childEnv.PI_MCP_FORWARD_TOKEN;
			}
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				env: childEnv,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let settled = false;
			let abortListener: (() => void) | undefined;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanupAbort = () => {
				if (killTimer) clearTimeout(killTimer);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
			};
			const settle = (code: number) => {
				if (settled) return;
				settled = true;
				cleanupAbort();
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, signalName) => {
				if (buffer.trim()) processLine(buffer);
				settle(code ?? (signalName ? 1 : 0));
			});

			proc.on("error", (error) => {
				currentResult.errorMessage = error.message;
				settle(1);
			});

			if (signal) {
				abortListener = () => {
					wasAborted = true;
					try {
						proc.kill("SIGTERM");
					} catch {
						// The child may have exited between the abort and kill calls.
					}
					killTimer = setTimeout(() => {
						if (proc.exitCode === null) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) abortListener();
				else signal.addEventListener("abort", abortListener, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			currentResult.exitCode ||= 1;
			currentResult.errorMessage = "Subagent was aborted";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		await forwardingBridge?.close();
	}
}

const BUNDLED_AGENT_GUIDANCE = [
	"scout — fast repository reconnaissance (gpt-5.6-luna)",
	"planner — read-only implementation planning (claude-opus-5)",
	"reviewer — read-only code quality and security review (claude-opus-5)",
	"worker — general implementation with full capabilities (gpt-5.6-terra)",
	"datadog-investigator — read-only evidence-first Datadog investigation (gpt-5.6-luna)",
].join("; ");
const AGENT_NAME_DESCRIPTION = `Exact bundled agent names: ${BUNDLED_AGENT_GUIDANCE}. Custom user/project agents may also be available; they are discovered at runtime.`;

const TaskItem = Type.Object({
	agent: Type.String({ description: AGENT_NAME_DESCRIPTION }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: AGENT_NAME_DESCRIPTION }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: `${AGENT_NAME_DESCRIPTION} (for single mode)` })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await installBundledAgents();
		} catch (error) {
			ctx.ui.notify(`Could not install bundled subagent defaults: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await Promise.all([...RECOVERY_DIRECTORIES].map((dir) => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
		RECOVERY_DIRECTORIES.clear();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate large or context-heavy work to isolated agents; handle small edits directly. Modes: single, parallel for independent work, or chain with {previous}. Children cannot delegate. Available bundled agents (use these exact names): ${BUNDLED_AGENT_GUIDANCE}. Default scope: user; use both or project for ${CONFIG_DIR_NAME}/agents to include custom project agents.`,
		promptSnippet: "Delegate large or parallelizable work to isolated subagents",
		promptGuidelines: [
			"For substantial implementation, chain a worker, reviewer, then worker to apply review feedback.",
			"Review and validate delegated changes; prefer git mv for one-to-one moves and ast-grep for mechanical refactors.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results: results.map(compactResult),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				if (params.chain.length > MAX_CHAIN_STEPS)
					return {
						content: [{ type: "text", text: `Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_STEPS}.` }],
						details: makeDetails("chain")([]),
					};

				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					// Function replacement prevents $-sequences in prior output from
					// being interpreted as replacement-string capture references.
					const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (currentResult) => {
								const compact = compactResult(currentResult);
								onUpdate({
									content: [{ type: "text", text: `Chain step ${i + 1}/${params.chain!.length}: ${compact.output || "(running...)"}` }],
									details: makeDetails("chain")([...results, currentResult]),
								});
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						ctx,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
					);
					await finalizeResult(result);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${result.output}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					const handoff = boundHeadText(getResultOutput(result), FINAL_OUTPUT_BYTES, FINAL_OUTPUT_LINES);
					previousOutput = `${handoff.text}${handoff.truncated ? `\n\n[Previous output truncated by ${handoff.truncatedBy ?? "limit"}: retained beginning (${FINAL_OUTPUT_BYTES} bytes / ${FINAL_OUTPUT_LINES} lines); total ${handoff.totalBytes} bytes / ${handoff.totalLines} lines.]` : ""}`;
				}
				return {
					content: [{ type: "text", text: results[results.length - 1].output || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						ctx,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(current) => {
							allResults[index] = current;
							emitParallelUpdate();
						},
					);
					await finalizeResult(result);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = r.output || compactResult(r).output;
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					ctx,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					(current) => onUpdate?.({
						content: [{ type: "text", text: compactResult(current).output || "(running...)" }],
						details: makeDetails("single")([current]),
					}),
				);
				await finalizeResult(result);
				const isError = isFailedResult(result);
				if (isError) {
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${result.output}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: result.output || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const aggregateUsage = (results: CompactResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					const usage = r.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
					total.input += usage.input;
					total.output += usage.output;
					total.cacheRead += usage.cacheRead;
					total.cacheWrite += usage.cacheWrite;
					total.cost += usage.cost;
					total.turns += usage.turns;
				}
				return total;
			};
			const resultIcon = (r: CompactResult) =>
				r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const outputPreview = (r: CompactResult) => {
				const lines = (r.output ?? "").split("\n");
				return lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n..." : "");
			};
			const addExpandedResult = (container: Container, r: CompactResult, label: string) => {
				container.addChild(new Spacer(1));
				container.addChild(new Text(`${theme.fg("muted", label)}${theme.fg("accent", r.agent)} ${resultIcon(r)}`, 0, 0));
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				if (r.output) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(r.output.trim(), 0, 0, mdTheme));
				}
				const usage = formatUsageStats(r.usage, r.model);
				if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				let header = `${resultIcon(r)} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isFailedResult(r) && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (expanded) {
					const container = new Container();
					container.addChild(new Text(header, 0, 0));
					addExpandedResult(container, r, "─── ");
					return container;
				}
				const usage = formatUsageStats(r.usage, r.model);
				return new Text(`${header}\n${theme.fg("toolOutput", outputPreview(r) || "(no output)")}${usage ? `\n${theme.fg("dim", usage)}` : ""}`, 0, 0);
			}

			const running = details.results.filter((r) => r.exitCode === -1).length;
			const succeeded = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
			const failed = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
			const isChain = details.mode === "chain";
			const title = isChain ? "chain" : "parallel";
			const status = running ? `${succeeded + failed}/${details.results.length} done, ${running} running` : `${succeeded}/${details.results.length} ${isChain ? "steps" : "tasks"}`;
			const icon = running ? theme.fg("warning", "⏳") : failed ? theme.fg("warning", "◐") : theme.fg("success", "✓");

			if (expanded && !running) {
				const container = new Container();
				container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(`${title} `))}${theme.fg("accent", status)}`, 0, 0));
				for (const r of details.results) addExpandedResult(container, r, isChain ? `─── Step ${r.step}: ` : "─── ");
				const usage = formatUsageStats(aggregateUsage(details.results));
				if (usage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${title} `))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				text += `\n\n${theme.fg("muted", isChain ? `─── Step ${r.step}: ` : "─── ")}${theme.fg("accent", r.agent)} ${resultIcon(r)}`;
				text += `\n${theme.fg("toolOutput", r.exitCode === -1 && !r.output ? "(running...)" : outputPreview(r))}`;
			}
			if (!running) {
				const usage = formatUsageStats(aggregateUsage(details.results));
				if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
			}
			if (!expanded) text += theme.fg("muted", "\n(Ctrl+O to expand)");
			return new Text(text, 0, 0);
		},
	});
}
