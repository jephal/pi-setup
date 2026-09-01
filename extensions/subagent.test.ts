import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import registerSubagent, { boundHeadText, boundText, buildChildArgs, childProcessToolNames, childToolNames, compactResult, getFinalOutput, isFailedResult, sanitizeText, unsupportedChildToolNames } from "./subagent/index.ts";

test("subagent tool contract lists the bundled agent names", () => {
	const registered: any[] = [];
	registerSubagent({
		on: () => undefined,
		registerTool: (tool: any) => registered.push(tool),
	} as any);

	const definition = registered.find((tool) => tool.name === "subagent");
	assert.ok(definition);
	for (const name of ["scout", "planner", "reviewer", "worker", "datadog-investigator"]) {
		assert.match(definition.description, new RegExp(name));
		assert.match(definition.parameters.properties.agent.description, new RegExp(name));
	}
});

test("subagent helpers concatenate final assistant text and sanitize bounded output", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "earlier" }] },
		{ role: "assistant", content: [{ type: "text", text: "final " }, { type: "text", text: "answer" }] },
	] as unknown as Message[];

	assert.equal(getFinalOutput(messages), "final answer");
	assert.equal(getFinalOutput([...messages, { role: "assistant", content: [{ type: "text", text: "" }] }] as unknown as Message[]), "");
	assert.equal(sanitizeText("ok\u001b[31m red\u0000"), "ok red");
	const bounded = boundText("one\ntwo\nthree", 1024, 2);
	assert.equal(bounded.text, "two\nthree");
	assert.equal(bounded.truncated, true);
});

test("subagent child tools use the minimal worker default and pass bridge-authorized Datadog names", () => {
	const configured = childToolNames({ tools: ["read", "subagent", "datadog_query", "write", "read"] } as any);
	assert.deepEqual(configured, ["read", "write"]);
	assert.deepEqual(unsupportedChildToolNames({ tools: ["read", "subagent", "datadog_query", "write"] } as any), ["subagent", "datadog_query"]);

	const workerDefaults = childToolNames({} as any);
	assert.deepEqual(workerDefaults, ["read", "bash", "write", "edit", "find", "grep", "ls"]);
	assert.deepEqual(childProcessToolNames(["read", "datadog_search_tools"], ["datadog_logs", "datadog_logs"]), ["read", "datadog_search_tools", "datadog_logs"]);
});

test("subagent child arguments preserve parent high-thinking defaults unless the agent chooses a model", () => {
	const parent = { model: { provider: "openai", id: "gpt-5.6" }, thinkingLevel: "high" } as any;
	assert.deepEqual(buildChildArgs({ model: undefined }, parent), ["--mode", "json", "-p", "--no-session", "--model", "openai/gpt-5.6", "--thinking", "high"]);
	assert.deepEqual(buildChildArgs({ model: "openai/gpt-5.6-terra" }, parent), ["--mode", "json", "-p", "--no-session", "--model", "openai/gpt-5.6-terra"]);
});

test("subagent streaming details bound raw stderr and retain long single-line tasks", () => {
	const compact = compactResult({
		agent: "worker",
		agentSource: "user",
		task: `task-${"x".repeat(3_000)}`,
		exitCode: -1,
		messages: [],
		stderr: `first\n\u001b[31m${"x".repeat(3_000)}\u0000`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	} as any);
	assert.equal(compact.task.startsWith("task-"), true);
	assert.equal(Buffer.byteLength(compact.task, "utf8"), 2 * 1024);
	assert.doesNotMatch(compact.stderr, /\u001b|\u0000/);
	assert.match(compact.stderr, /Output truncated/);
});

test("subagent final output and handoffs retain the head while stderr retains the tail", () => {
	const output = ["first", ...Array.from({ length: 200 }, (_, index) => `line-${index}`)].join("\n");
	const head = boundHeadText(output, 12 * 1024, 160);
	assert.equal(head.text.split("\n")[0], "first");
	assert.equal(head.truncated, true);
	assert.equal(head.totalLines, 201);

	const longSingleLine = `start-${"x".repeat(20_000)}`;
	const longHead = boundHeadText(longSingleLine, 12 * 1024, 160);
	assert.equal(longHead.text.startsWith("start-"), true);
	assert.equal(Buffer.byteLength(longHead.text, "utf8"), 12 * 1024);

	const stderr = boundText(output, 12 * 1024, 2);
	assert.equal(stderr.text.split("\n").at(-1), "line-199");
	assert.equal(stderr.truncated, true);
});

test("a running subagent sentinel is not a failure", () => {
	assert.equal(isFailedResult({ exitCode: -1 }), false);
	assert.equal(isFailedResult({ exitCode: 0 }), false);
	assert.equal(isFailedResult({ exitCode: 1 }), true);
});
