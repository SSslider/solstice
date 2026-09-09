"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { TaskContinuity } = require("./taskContinuity");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "felix-continuity-"));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log("ok - " + name); }
(async () => {
try {
	const journal = new TaskContinuity(root);
	const task = journal.begin("thread-1", "Build the booking flow", "gpt-6-astra");
	check("dispatch is durable before any model output", () => assert.equal(new TaskContinuity(root).read(task.id).status, "running"));
	journal.notify("turn/plan/updated", { threadId: "thread-1", plan: [{ step: "Persist booking", status: "inProgress" }] });
	check("plan survives controller recreation", () => assert.equal(new TaskContinuity(root).read(task.id).plan[0].step, "Persist booking"));
	journal.notify("item/started", { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", command: "private credentials" } });
	check("unknown command outcome is retained", () => assert.equal(new TaskContinuity(root).read(task.id).pending[0].id, "cmd-1"));
	check("command arguments are not copied into journal", () => assert.ok(!fs.readFileSync(journal.file(task.id), "utf8").includes("private credentials")));
	fs.writeFileSync(path.join(root, "app.js"), "booking v1");
	journal.notify("item/completed", { threadId: "thread-1", item: { id: "edit-1", type: "fileChange", changes: [{ path: "app.js" }] } });
	check("file evidence comes from disk", () => assert.equal(journal.read(task.id).evidence[0].bytes, 10));
	check("recovery refuses a task owned by a live process", () => assert.throws(() => new TaskContinuity(root).recoveryPrompt(task.id), /still be running/));
	journal.interruptAll();
	check("fresh recovery verifies unchanged files", () => assert.match(new TaskContinuity(root).recoveryPrompt(task.id), /"current":"unchanged"/));
	fs.writeFileSync(path.join(root, "app.js"), "booking v2");
	check("recovery detects subsequent edits", () => assert.match(journal.recoveryPrompt(task.id), /"current":"changed"/));
	fs.unlinkSync(path.join(root, "app.js"));
	check("recovery detects a missing artifact", () => assert.match(journal.recoveryPrompt(task.id), /"current":"missing"/));
	journal.notify("turn/completed", { threadId: "thread-1", turn: {} });
	check("turn ending cannot hide unresolved operations", () => assert.equal(journal.read(task.id).status, "interrupted"));
	journal.notify("item/completed", { threadId: "thread-1", item: { id: "cmd-1", type: "commandExecution", status: "completed", exitCode: 0 } });
	journal.notify("turn/completed", { threadId: "thread-1", turn: {} });
	check("model completion requires review, never means delivered", () => assert.equal(journal.read(task.id).status, "needs_review"));
	journal.begin("thread-1", "Continue", "gpt-6-astra");
	journal.notify("error", { threadId: "thread-1", error: { message: "provider failed" } });
	journal.notify("turn/completed", { threadId: "thread-1", turn: {} });
	check("provider failure survives completion notification", () => assert.equal(journal.read(task.id).status, "interrupted"));
	journal.pause("thread-1");
	journal.notify("turn/completed", { threadId: "thread-1", turn: {} });
	check("user stop is preserved", () => assert.equal(journal.read(task.id).status, "paused"));
	check("other threads cannot change this task", () => {
		const before = fs.readFileSync(journal.file(task.id), "utf8");
		journal.notify("error", { threadId: "someone-else" });
		assert.equal(fs.readFileSync(journal.file(task.id), "utf8"), before);
	});
	check("workspace boundaries and secret files excluded from evidence", () => {
		fs.writeFileSync(path.join(root, ".env"), "private");
		assert.equal(journal.evidence(".env"), null);
		assert.equal(journal.evidence("../outside.txt"), null);
		assert.throws(() => journal.read("../outside"), /Invalid task/);
	});
	check("independent controllers do not overwrite task state", () => {
		const second = new TaskContinuity(root).begin("thread-1", "Another window", "claude-fable-5");
		assert.notEqual(second.id, task.id);
		assert.equal(journal.read(task.id).objective, "Build the booking flow");
	});
	// Execute the actual controller methods with a fake provider transport. The
	// callback verifies that a process failure at dispatch still leaves evidence.
	const file = path.join(__dirname, "extension.js");
	const compiled = new Module(file, module);
	compiled.filename = file;
	compiled.paths = module.paths;
	const baseRequire = compiled.require.bind(compiled);
	compiled.require = id => id === "vscode" ? {} : baseRequire(id);
	compiled._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.Controller = AgentController;", file);
	const Controller = compiled.exports.Controller;
	const c = Object.create(Controller.prototype);
	c.threadId = "controller-thread";
	c._lastUserPrompt = "Repair the real form";
	c.brandPackRootForThread = () => root;
	c.providerKey = () => "gpt-6-astra";
	check("controller writes a real checkpoint", () => {
		c.beginTaskCheckpoint(c.threadId, "enriched prompt");
		assert.equal(c.taskCheckpoint(root).list().find(t => t.threadId === c.threadId).objective, "Repair the real form");
	});
	check("controller and engine event paths use the same store", () => {
		const j = c.taskCheckpoint(root);
		j.notify("item/started", { threadId: c.threadId, item: { type: "mcpToolCall", id: "pending-api" } });
		j.interruptAll();
		const saved = new TaskContinuity(root).list().find(t => t.threadId === c.threadId);
		assert.equal(saved.status, "interrupted");
		assert.equal(saved.pending[0].id, "pending-api");
	});
	c.withBrandPack = text => text;
	c.recordSkillPrompt = () => {};
	c.ensureRunnable = async () => {};
	c.upsertThread = () => ({ preview: 'existing' });
	c.ensureClient = async () => ({ request: async method => {
		assert.equal(method, 'turn/start');
		const saved = new TaskContinuity(root).list().find(t => t.threadId === c.threadId);
		assert.equal(saved.status, 'running');
		throw new Error('simulated provider crash');
	} });
	await assert.rejects(c.startTurn(c.threadId, 'Fix the form'), /simulated provider crash/);
	passed++; console.log('ok - actual controller dispatch checkpoints before provider failure');
	const queued = journal.queueSteering('thread-1', 'Keep the Hebrew labels');
	check('queued user update survives a new controller', () => assert.equal(new TaskContinuity(root).read(task.id).steering[0].text, 'Keep the Hebrew labels'));
	const batch = journal.markSteering('thread-1', null, 'dispatching');
	check('drain marks ambiguous dispatch before sending', () => { assert.deepEqual(batch, [queued]); assert.equal(journal.read(task.id).steering[0].state, 'dispatching'); });
	const newer = journal.queueSteering('thread-1', 'Use local dates');
	journal.markSteering('thread-1', batch, 'accepted');
	check('old acknowledgement cannot consume a newer update', () => assert.equal(journal.read(task.id).steering.find(x => x.id === newer).state, 'queued'));
	journal.pause('thread-1');
	check('stop cancels updates that were not dispatched', () => assert.equal(journal.read(task.id).steering.find(x => x.id === newer).state, 'cancelled'));
	check('recovery distinguishes accepted and cancelled updates', () => { const prompt = journal.recoveryPrompt(task.id); assert.match(prompt, /"state":"accepted"/); assert.match(prompt, /"state":"cancelled"/); });
	check('oversized steering is rejected without truncating user intent', () => { const before = journal.read(task.id).steering.length; assert.throws(() => journal.queueSteering('thread-1', 'x'.repeat(24001)), /limit/); assert.equal(journal.read(task.id).steering.length, before); });
	c.threads = new Map([[c.threadId, {activeTurnId:'turn-1'}]]);
	c.ensureClient = async () => ({ request: async method => { assert.equal(method, 'turn/steer'); throw new Error('ack lost'); } });
	await assert.rejects(c.steer(c.threadId, 'Change the field label'), /ack lost/);
	check('native steering failure keeps the real user update on disk', () => { const saved = c.taskCheckpoint(root).list().find(t => t.threadId === c.threadId); assert.equal(saved.steering.at(-1).state, 'dispatching'); assert.equal(saved.steering.at(-1).text, 'Change the field label'); });
	check('failed storage cannot leave a phantom update in memory', () => {
		const before = JSON.stringify(journal.active.get('thread-1'));
		const save = journal.save;
		journal.save = () => { throw new Error('disk full'); };
		try { assert.throws(() => journal.queueSteering('thread-1', 'Do not lose this'), /disk full/); }
		finally { journal.save = save; }
		assert.equal(JSON.stringify(journal.active.get('thread-1')), before);
	});
	check('failed acknowledgement storage preserves the uncertain outcome', () => {
		const id = journal.queueSteering('thread-1', 'Pending ACK', 'dispatching');
		const save = journal.save;
		journal.save = () => { throw new Error('disk full'); };
		try { assert.throws(() => journal.markSteering('thread-1', [id], 'accepted'), /disk full/); }
		finally { journal.save = save; }
		assert.equal(journal.active.get('thread-1').steering.find(x => x.id === id).state, 'dispatching');
		assert.equal(journal.read(task.id).steering.find(x => x.id === id).state, 'dispatching');
	});
	c.providerKey = () => 'claude-fable-5';
	c.claude = { busy: true };
	c.steerQueue = [];
	c.liveRec = () => ({});
	c.post = () => {};
	c.output = {append: () => {}};
	c.live = new Map();
	await c.steer(c.threadId, 'enriched instruction', 'Keep RTL');
	check('busy CLI controller stores raw intent before queueing', () => {
		assert.equal(c.taskCheckpoint(root).active.get(c.threadId).steering.at(-1).text, 'Keep RTL');
		assert.equal(c.steerQueue.length, 1);
	});
	let ack;
	c.send = () => {
		assert.equal(c.taskCheckpoint(root).active.get(c.threadId).steering.at(-1).state, 'dispatching');
		return new Promise(resolve => { ack = resolve; });
	};
	c.drainSteerQueue();
	await c.steer(c.threadId, 'new instruction', 'Preserve mobile layout');
	ack();
	await new Promise(resolve => setImmediate(resolve));
	check('actual drain ACK leaves newly queued instructions pending', () => {
		const rows = c.taskCheckpoint(root).active.get(c.threadId).steering;
		assert.equal(rows.find(x => x.text === 'Keep RTL').state, 'accepted');
		assert.equal(rows.at(-1).state, 'queued');
		assert.equal(c.steerQueue.length, 1);
	});
	console.log(`taskContinuity.test.js: ${passed}/${passed} checks passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }

})().catch(error => { console.error(error); process.exitCode = 1; });
