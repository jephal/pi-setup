import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import {
	BackgroundTaskManager,
	MAX_BACKGROUND_BATCHES,
	MAX_REPLAY_BYTES,
	MAX_TERMINAL_TASKS,
	buildFollowUpReplay,
} from "./subagent/background.ts";
import { createSupervisorBridge, sendSupervisorReport, type SupervisorReport } from "./subagent/supervisor-bridge.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await wait(10);
	}
}

function fakeRpcChildScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer='';",
		"process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); console.log(JSON.stringify({type:'response',id:c.id,success:true})); if(c.type==='prompt'||c.type==='follow_up'||c.type==='steer'){ console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'child output'}],model:'fake/model'}})); console.log(JSON.stringify({type:'agent_settled'})); } } });",
	].join("");
}

function fakeSpec(id: string, task: string) {
	const spec: any = {
		id,
		agent: "worker",
		agentSource: "user" as const,
		task,
		cwd: process.cwd(),
		command: process.execPath,
		args: ["-e", fakeRpcChildScript()],
		env: { ...process.env },
		bridge: { env: {}, close: async () => undefined },
		onReport: () => undefined,
		onSettled: () => undefined,
	};
	spec.createFollowUp = async (replayPrompt: string) => ({ ...fakeSpec(id, replayPrompt), onSettled: spec.onSettled });
	return spec;
}

function settlesBeforePromptResponseScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer='';",
		"process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); if(c.type==='prompt'){ console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'early output'}]}})); console.log(JSON.stringify({type:'agent_settled'})); setTimeout(() => console.log(JSON.stringify({type:'response',id:c.id,success:true})), 10); } } });",
	].join("");
}

function delayedSettlementRaceScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer='';",
		"const out = event => console.log(JSON.stringify(event));",
		"process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); out({type:'response',id:c.id,success:true}); if(c.type==='prompt'){ out({type:'agent_start'}); out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'first output'}],model:'fake/model'}}); out({type:'agent_settled'}); out({type:'agent_start'}); setTimeout(() => { out({type:'agent_settled'}); setTimeout(() => { out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'current output'}],model:'fake/model'}}); out({type:'agent_settled'}); }, 50); }, 0); } } });",
	].join("");
}

function cleanExitWithoutSettlementScript(): string {
	return "process.stdin.setEncoding('utf8'); process.stdin.once('data', chunk => { const c=JSON.parse(chunk); console.log(JSON.stringify({type:'response',id:c.id,success:true})); process.exit(0); });";
}

function liveFollowUpScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer='';",
		"process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); console.log(JSON.stringify({type:'response',id:c.id,success:true})); if(c.type==='prompt'){ console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'waiting'}],model:'fake/model'}})); } if(c.type==='follow_up'){ console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'live follow-up'}],model:'fake/model'}})); console.log(JSON.stringify({type:'agent_settled'})); } } });",
	].join('');
}

function promptEchoScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer='';",
		"process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); console.log(JSON.stringify({type:'response',id:c.id,success:true})); if(c.type==='prompt'||c.type==='follow_up'){ console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'received:'+c.message}],model:'fake/model'}})); console.log(JSON.stringify({type:'agent_settled'})); } } });",
	].join("");
}

test("supervisor bridge authenticates and delivers bounded reports", async () => {
	const reports: SupervisorReport[] = [];
	const bridge = await createSupervisorBridge("task-1", (report) => reports.push(report));
	const previous = {
		socket: process.env.PI_SUBAGENT_SUPERVISOR_SOCKET,
		token: process.env.PI_SUBAGENT_SUPERVISOR_TOKEN,
		task: process.env.PI_SUBAGENT_SUPERVISOR_TASK,
	};
	try {
		Object.assign(process.env, bridge.env);
		await sendSupervisorReport("Need a product decision", "need_decision");
		assert.deepEqual(reports.map(({ taskId, message, kind }) => ({ taskId, message, kind })), [
			{ taskId: "task-1", message: "Need a product decision", kind: "need_decision" },
		]);
		process.env.PI_SUBAGENT_SUPERVISOR_TOKEN = "wrong-token";
		await assert.rejects(sendSupervisorReport("rejected", "progress_update"), /authorization|rejected/i);
	} finally {
		if (previous.socket === undefined) delete process.env.PI_SUBAGENT_SUPERVISOR_SOCKET;
		else process.env.PI_SUBAGENT_SUPERVISOR_SOCKET = previous.socket;
		if (previous.token === undefined) delete process.env.PI_SUBAGENT_SUPERVISOR_TOKEN;
		else process.env.PI_SUBAGENT_SUPERVISOR_TOKEN = previous.token;
		if (previous.task === undefined) delete process.env.PI_SUBAGENT_SUPERVISOR_TASK;
		else process.env.PI_SUBAGENT_SUPERVISOR_TASK = previous.task;
		await bridge.close();
	}
});

test("supervisor bridge abort after creation closes its socket and is idempotent", async () => {
	const controller = new AbortController();
	const bridge = await createSupervisorBridge("task-abort", () => undefined, controller.signal);
	const socketPath = bridge.env.PI_SUBAGENT_SUPERVISOR_SOCKET;
	controller.abort();
	for (let i = 0; i < 100; i++) {
		try { await access(socketPath); } catch { break; }
		await wait(1);
	}
	await assert.rejects(access(socketPath), /ENOENT/);
	await bridge.close();
	await bridge.close();
});

test("background shutdown cancels a child that is still waiting for startup RPC", async () => {
	const manager = new BackgroundTaskManager();
	let bridgeClosed = 0;
	const bridge = { env: {}, close: async () => { bridgeClosed++; } };
	const start = manager.start({
		id: "pending-start", agent: "worker", agentSource: "user", task: "wait", cwd: process.cwd(),
		command: process.execPath, args: ["-e", "process.stdin.resume();"], env: { ...process.env }, bridge,
		onReport: () => undefined, onSettled: () => undefined,
	});
	const shutdown = manager.shutdown();
	await assert.rejects(start, /aborted|shutdown|closed/i);
	await shutdown;
	assert.equal(bridgeClosed, 1);
	assert.deepEqual(manager.list(), []);
});

test("caller cancellation after background startup does not cancel the child", async () => {
	const manager = new BackgroundTaskManager();
	const caller = new AbortController();
	const snapshot = await manager.start({
		id: "caller-abort", agent: "worker", agentSource: "user", task: "inspect", cwd: process.cwd(),
		command: process.execPath, args: ["-e", fakeRpcChildScript()], env: { ...process.env }, signal: caller.signal,
		bridge: { env: {}, close: async () => undefined }, onReport: () => undefined, onSettled: () => undefined,
	});
	assert.equal(snapshot.id, "caller-abort");
	caller.abort();
	const sent = await manager.send("caller-abort", "continue after the caller returned", "followUp");
	assert.equal(sent.status, "running");
	await waitFor(() => manager.get("caller-abort")?.status === "completed");
	await manager.shutdown();
});

test("startup buffers a terminal child until it is registered", async () => {
	const manager = new BackgroundTaskManager();
	let bridgeClosed = 0;
	await manager.start({
		id: "early-terminal", agent: "worker", agentSource: "user", task: "finish early", cwd: process.cwd(),
		command: process.execPath, args: ["-e", settlesBeforePromptResponseScript()], env: { ...process.env },
		bridge: { env: {}, close: async () => { bridgeClosed++; } }, onReport: () => undefined, onSettled: () => undefined,
	});
	await waitFor(() => manager.get("early-terminal")?.status === "completed");
	assert.deepEqual(manager.list(), []);
	assert.equal(bridgeClosed, 1);
	await manager.shutdown();
});

test("background shutdown suppresses a deferred completion callback", async () => {
	const manager = new BackgroundTaskManager();
	let callbacks = 0;
	await manager.start({
		id: "settlement-race", agent: "worker", agentSource: "user", task: "inspect", cwd: process.cwd(),
		command: process.execPath, args: ["-e", fakeRpcChildScript()], env: { ...process.env },
		bridge: { env: {}, close: async () => undefined }, onReport: () => undefined, onSettled: () => { callbacks++; },
	});
	await manager.shutdown();
	await wait(20);
	assert.equal(callbacks, 0);
});

test("background settlement ignores a delayed prior turn before the current turn settles", async () => {
	const manager = new BackgroundTaskManager();
	const settledOutputs: string[] = [];
	await manager.start({
		id: "delayed-settlement", agent: "worker", agentSource: "user", task: "inspect", cwd: process.cwd(),
		command: process.execPath, args: ["-e", delayedSettlementRaceScript()], env: { ...process.env },
		bridge: { env: {}, close: async () => undefined }, onReport: () => undefined, onSettled: (task) => settledOutputs.push(task.output),
	});
	await wait(20);
	assert.deepEqual(settledOutputs, []);
	await waitFor(() => settledOutputs.length === 1);
	assert.match(settledOutputs[0], /current output/);
	await manager.shutdown();
});

test("background shutdown force-kills a child that ignores SIGTERM", async () => {
	const manager = new BackgroundTaskManager();
	const start = manager.start({
		id: "sigterm-ignored", agent: "worker", agentSource: "user", task: "wait", cwd: process.cwd(),
		command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{}); process.stdin.resume();"], env: { ...process.env },
		bridge: { env: {}, close: async () => undefined }, onReport: () => undefined, onSettled: () => undefined,
	});
	await wait(50);
	const started = Date.now();
	const shutdown = manager.shutdown();
	await assert.rejects(start, /aborted|shutdown|closed/i);
	await shutdown;
	assert.ok(Date.now() - started < 4_000);
});

test("background batches start several children and settle once without polling", async () => {
	const manager = new BackgroundTaskManager();
	const settled: string[] = [];
	const started = await manager.startBatch([fakeSpec("batch-task-1", "inspect auth"), fakeSpec("batch-task-2", "inspect tests")], (batch) => settled.push(batch.id));
	assert.equal(started.tasks.length, 2);
	assert.equal(started.batch.total, 2);
	await waitFor(() => manager.getBatch(started.batch.id)?.status === "completed");
	assert.equal(manager.getBatch(started.batch.id)?.completed, 2);
	assert.deepEqual(settled, [started.batch.id]);
	await manager.send("batch-task-1", "also inspect migrations", "followUp");
	await waitFor(() => settled.length === 2);
	assert.deepEqual(settled, [started.batch.id, started.batch.id]);
	await manager.shutdown();
});

test("failed batch startup rolls back children that already started", async () => {
	const manager = new BackgroundTaskManager();
	const invalid = { ...fakeSpec("rollback-invalid", "fail to start"), command: "/definitely/not-a-command" };
	await assert.rejects(manager.startBatch([fakeSpec("rollback-valid", "start normally"), invalid], () => undefined), /(spawn|ENOENT|not found)/i);
	assert.equal(manager.list().length, 0);
	await manager.shutdown();
});

test("background task manager returns immediately and preserves RPC child context for follow-ups", async () => {
	const manager = new BackgroundTaskManager();
	const settled: string[] = [];
	const taskSpec = fakeSpec("task-2", "inspect");
	taskSpec.onSettled = (task) => settled.push(task.output);
	const snapshot = await manager.start(taskSpec);
	assert.equal(snapshot.id, "task-2");
	await waitFor(() => manager.get("task-2")?.status === "completed");
	assert.match(manager.get("task-2")?.output || "", /child output/);
	const sent = await manager.send("task-2", "also inspect tests", "followUp");
	assert.equal(sent.status, "running");
	await waitFor(() => settled.length >= 2);
	await waitFor(() => manager.get("task-2")?.status === "completed");
	const cancelled = await manager.cancel("task-2");
	assert.equal(cancelled.status, "completed");
	await manager.shutdown();
});

test("capacity counts only active children and completed children release bridges", async () => {
	const manager = new BackgroundTaskManager();
	let closed = 0;
	for (let i = 0; i < 8; i++) {
		await manager.start({ ...fakeSpec(`capacity-${i}`, "work"), bridge: { env: {}, close: async () => { closed++; } } });
	}
	await waitFor(() => manager.list().length === 0);
	assert.equal(closed, 8);
	const ninth = await manager.start({ ...fakeSpec("capacity-9", "work"), bridge: { env: {}, close: async () => { closed++; } } });
	assert.equal(ninth.id, "capacity-9");
	await manager.shutdown();
	assert.equal(closed, 9);
});

test("a clean child exit without agent_settled fails and releases resources", async () => {
	const manager = new BackgroundTaskManager();
	let closed = 0;
	await manager.start({
		id: "clean-exit", agent: "worker", agentSource: "user", task: "exit", cwd: process.cwd(), command: process.execPath,
		args: ["-e", cleanExitWithoutSettlementScript()], env: { ...process.env },
		bridge: { env: {}, close: async () => { closed++; } }, onReport: () => undefined, onSettled: () => undefined,
	});
	await waitFor(() => manager.get("clean-exit")?.status === "failed");
	assert.match(manager.get("clean-exit")?.errorMessage || "", /agent_settled/);
	assert.equal(closed, 1);
	await manager.shutdown();
});

test("active follow-ups preserve the live RPC child", async () => {
	const manager = new BackgroundTaskManager();
	let bridgesClosed = 0;
	await manager.start({
		id: "live-follow-up", agent: "worker", agentSource: "user", task: "start", cwd: process.cwd(),
		command: process.execPath, args: ["-e", liveFollowUpScript()], env: { ...process.env },
		bridge: { env: {}, close: async () => { bridgesClosed++; } }, onReport: () => undefined, onSettled: () => undefined,
	});
	assert.equal(manager.get("live-follow-up")?.status, "running");
	await manager.send("live-follow-up", "continue in the same context", "followUp");
	await waitFor(() => manager.get("live-follow-up")?.status === "completed");
	assert.match(manager.get("live-follow-up")?.output || "", /live follow-up/);
	assert.equal(bridgesClosed, 1);
	await manager.shutdown();
});

test("completed follow-up starts a fresh child with bounded replay and keeps its task ID", async () => {
	const manager = new BackgroundTaskManager();
	let factories = 0;
	let bridgesClosed = 0;
	const spec = {
		...fakeSpec("fresh-follow-up", "original work"),
		bridge: { env: {}, close: async () => { bridgesClosed++; } },
		args: ["-e", promptEchoScript()],
	};
	spec.createFollowUp = async (replayPrompt: string) => {
		factories++;
		return {
			...spec,
			task: replayPrompt,
			bridge: { env: {}, close: async () => { bridgesClosed++; } },
			onStarted: undefined,
		};
	};
	await manager.start(spec);
	await waitFor(() => manager.get("fresh-follow-up")?.status === "completed");
	assert.equal(manager.get("fresh-follow-up")?.generation, 0);
	const sent = await manager.send("fresh-follow-up", "new request", "followUp");
	assert.equal(sent.id, "fresh-follow-up");
	assert.equal(factories, 1);
	await waitFor(() => manager.get("fresh-follow-up")?.status === "completed");
	assert.equal(manager.get("fresh-follow-up")?.generation, 1);
	assert.match(manager.get("fresh-follow-up")?.output || "", /Bounded previous output/);
	assert.match(manager.get("fresh-follow-up")?.output || "", /new request/);
	assert.equal(bridgesClosed, 2);
	await manager.shutdown();
});

test("completed follow-ups reject concurrent restart requests", async () => {
	const manager = new BackgroundTaskManager();
	const spec = fakeSpec("follow-up-lock", "work");
	const factory = spec.createFollowUp;
	spec.createFollowUp = async (prompt: string) => {
		await wait(30);
		return factory(prompt);
	};
	await manager.start(spec);
	await waitFor(() => manager.get("follow-up-lock")?.status === "completed");
	const first = manager.send("follow-up-lock", "first", "followUp");
	await assert.rejects(manager.send("follow-up-lock", "second", "followUp"), /follow-up in progress/i);
	await first;
	await waitFor(() => manager.get("follow-up-lock")?.status === "completed");
	await manager.shutdown();
});

test("replay keeps its preamble and UTF-8 byte bound", () => {
	const replay = buildFollowUpReplay({
		id: "replay", agent: "worker", agentSource: "user", task: "原始任务".repeat(10_000), cwd: process.cwd(), status: "completed",
		output: "输出".repeat(10_000), stderr: "诊断".repeat(10_000), reports: [], startedAt: 0, updatedAt: 0,
	}, "请求".repeat(100_000));
	assert.match(replay, /^Continue the completed background task in a fresh child/);
	assert.match(replay, /New follow-up request:/);
	assert.ok(Buffer.byteLength(replay, "utf8") <= MAX_REPLAY_BYTES);
});

test("duplicate task IDs are rejected without replacing the live child", async () => {
	const manager = new BackgroundTaskManager();
	await manager.start(fakeSpec("duplicate-id", "first"));
	await assert.rejects(manager.start(fakeSpec("duplicate-id", "second")), /already in use/i);
	assert.equal(manager.get("duplicate-id")?.task, "first");
	await manager.shutdown();
});

test("terminal and batch records are bounded", async () => {
	const manager = new BackgroundTaskManager();
	for (let i = 0; i < MAX_TERMINAL_TASKS + 1; i++) {
		const id = `retained-${i}`;
		await manager.start(fakeSpec(id, "work"));
		await waitFor(() => manager.get(id)?.status === "completed");
	}
	assert.equal(manager.get("retained-0"), undefined);
	assert.ok(manager.get(`retained-${MAX_TERMINAL_TASKS}`));
	for (let i = 0; i < MAX_BACKGROUND_BATCHES + 1; i++) {
		const started = await manager.startBatch([fakeSpec(`batch-retained-${i}`, "work")], () => undefined);
		await waitFor(() => manager.getBatch(started.batch.id)?.status === "completed");
	}
	assert.equal(manager.listBatches().length, MAX_BACKGROUND_BATCHES);
	await manager.shutdown();
});

test("result reads consume detailed output but repeated retrieval keeps compact continuation state", async () => {
	const manager = new BackgroundTaskManager();
	await manager.start(fakeSpec("consume-result", "work"));
	await waitFor(() => manager.get("consume-result")?.status === "completed");
	const first = manager.consumeResult("consume-result");
	assert.equal(first?.consumed, false);
	assert.match(first?.snapshot.output || "", /child output/);
	const second = manager.consumeResult("consume-result");
	assert.equal(second?.consumed, true);
	assert.equal(second?.snapshot.resultConsumed, true);
	await manager.shutdown();
});

test("batch result snapshots remain stable after child cleanup and consumption", async () => {
	const manager = new BackgroundTaskManager();
	const started = await manager.startBatch([fakeSpec("stable-1", "one"), fakeSpec("stable-2", "two")], () => undefined);
	await waitFor(() => manager.getBatch(started.batch.id)?.status === "completed");
	const firstTasks = manager.getBatchTasks(started.batch.id);
	assert.deepEqual(firstTasks.map((task) => task.id), ["stable-1", "stable-2"]);
	assert.equal(manager.list().length, 0);
	const first = manager.consumeBatchResult(started.batch.id);
	assert.equal(first?.consumed, false);
	assert.equal(first?.tasks.length, 2);
	const second = manager.consumeBatchResult(started.batch.id);
	assert.equal(second?.consumed, true);
	assert.deepEqual(second?.batch.taskIds, ["stable-1", "stable-2"]);
	assert.deepEqual(manager.getBatchTasks(started.batch.id).map((task) => task.id), ["stable-1", "stable-2"]);
	await manager.shutdown();
});
