import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundTaskManager } from "./subagent/background.ts";
import { createSupervisorBridge, sendSupervisorReport, type SupervisorReport } from "./subagent/supervisor-bridge.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRpcChildScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer='';",
		"process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); console.log(JSON.stringify({type:'response',id:c.id,success:true})); if(c.type==='prompt'||c.type==='follow_up'||c.type==='steer'){ console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'child output'}],model:'fake/model'}})); console.log(JSON.stringify({type:'agent_settled'})); } } });",
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
	await wait(30);
	assert.equal(manager.get("task-2")?.status, "completed");
	assert.match(manager.get("task-2")?.output || "", /child output/);
	const sent = await manager.send("task-2", "also inspect tests", "followUp");
	assert.equal(sent.status, "running");
	await wait(30);
	assert.ok(settled.length >= 2);
	const cancelled = await manager.cancel("task-2");
	assert.equal(cancelled.status, "completed");
	await manager.shutdown();
});
