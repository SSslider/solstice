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
	console.log(`taskContinuity.test.js: ${passed}/${passed} checks passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }

})().catch(error => { console.error(error); process.exitCode = 1; });
