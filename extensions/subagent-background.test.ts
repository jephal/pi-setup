import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { BackgroundTaskManager } from "./subagent/background.ts";
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
	return {
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
}

function delayedSettlementRaceScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer='';",
		"const out = event => console.log(JSON.stringify(event));",
		"process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); out({type:'response',id:c.id,success:true}); if(c.type==='prompt'){ out({type:'agent_start'}); out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'first output'}],model:'fake/model'}}); out({type:'agent_settled'}); out({type:'agent_start'}); setTimeout(() => { out({type:'agent_settled'}); setTimeout(() => { out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'current output'}],model:'fake/model'}}); out({type:'agent_settled'}); }, 50); }, 0); } } });",
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
		try {
			await access(socketPath);
		} catch {
			break;
		}
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
		id: "pending-start",
		agent: "worker",
		agentSource: "user",
		task: "wait",
		cwd: process.cwd(),
		command: process.execPath,
		args: ["-e", "process.stdin.resume();"],
		env: { ...process.env },
		bridge,
		onReport: () => undefined,
		onSettled: () => undefined,
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
	const bridge = { env: {}, close: async () => undefined };
	const snapshot = await manager.start({
		id: "caller-abort",
		agent: "worker",
		agentSource: "user",
		task: "inspect",
		cwd: process.cwd(),
		command: process.execPath,
		args: ["-e", fakeRpcChildScript()],
		env: { ...process.env },
		signal: caller.signal,
		bridge,
		onReport: () => undefined,
		onSettled: () => undefined,
	});
	assert.equal(snapshot.id, "caller-abort");
	caller.abort();
	const sent = await manager.send("caller-abort", "continue after the caller returned", "followUp");
	assert.equal(sent.status, "running");
	await waitFor(() => manager.get("caller-abort")?.status === "completed");
	await manager.shutdown();
});

test("background shutdown suppresses a deferred completion callback", async () => {
	const manager = new BackgroundTaskManager();
	let callbacks = 0;
	await manager.start({
		id: "settlement-race",
		agent: "worker",
		agentSource: "user",
		task: "inspect",
		cwd: process.cwd(),
		command: process.execPath,
		args: ["-e", fakeRpcChildScript()],
		env: { ...process.env },
		bridge: { env: {}, close: async () => undefined },
		onReport: () => undefined,
		onSettled: () => { callbacks++; },
	});
	await manager.shutdown();
	await wait(20);
	assert.equal(callbacks, 0);
});

test("background settlement ignores a delayed prior turn before the current turn settles", async () => {
	const manager = new BackgroundTaskManager();
	const settledOutputs: string[] = [];
	await manager.start({
		id: "delayed-settlement",
		agent: "worker",
		agentSource: "user",
		task: "inspect",
		cwd: process.cwd(),
		command: process.execPath,
		args: ["-e", delayedSettlementRaceScript()],
		env: { ...process.env },
		bridge: { env: {}, close: async () => undefined },
		onReport: () => undefined,
		onSettled: (task) => settledOutputs.push(task.output),
	});
	await wait(20);
	assert.deepEqual(settledOutputs, []);
	await waitFor(() => settledOutputs.length === 1);
	assert.match(settledOutputs[0], /current output/);
	await manager.shutdown();
});

test("background shutdown force-kills a child that ignores SIGTERM", async () => {
	const manager = new BackgroundTaskManager();
	const bridge = { env: {}, close: async () => undefined };
	const start = manager.start({
		id: "sigterm-ignored",
		agent: "worker",
		agentSource: "user",
		task: "wait",
		cwd: process.cwd(),
		command: process.execPath,
		args: ["-e", "process.on('SIGTERM',()=>{}); process.stdin.resume();"],
		env: { ...process.env },
		bridge,
		onReport: () => undefined,
		onSettled: () => undefined,
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
	const started = await manager.startBatch(
		[fakeSpec("batch-task-1", "inspect auth"), fakeSpec("batch-task-2", "inspect tests")],
		(batch) => settled.push(batch.id),
	);
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
	await assert.rejects(
		manager.startBatch([fakeSpec("rollback-valid", "start normally"), invalid], () => undefined),
		/(spawn|ENOENT|not found)/i,
	);
	assert.equal(manager.list().length, 0);
	await manager.shutdown();
});

test("background task manager returns immediately and preserves RPC child context for follow-ups", async () => {
	const manager = new BackgroundTaskManager();
	const settled: string[] = [];
	const bridge = { env: {}, close: async () => undefined };
	const started = Date.now();
	const snapshot = await manager.start({
		id: "task-2",
		agent: "worker",
		agentSource: "user",
		task: "inspect",
		cwd: process.cwd(),
		command: process.execPath,
		args: ["-e", fakeRpcChildScript()],
		env: { ...process.env },
		bridge,
		onReport: () => undefined,
		onSettled: (task) => settled.push(task.output),
	});
	assert.equal(snapshot.id, "task-2");
	assert.ok(Date.now() - started < 1000);
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
