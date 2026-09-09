"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { TaskContinuity } = require("./taskContinuity");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "felix-report-"));
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("ok - " + name); }
(async () => {
try {
	const journal = new TaskContinuity(root);
	const task = journal.begin("report-thread", "Build a booking form", "test");
	const file = path.join(__dirname, "extension.js");
	let choice = task.id, shown, errors = [], infos = [];
	const vscode = {
		workspace: { openTextDocument: async doc => doc },
		window: { showQuickPick: async rows => rows.find(row => row.id === choice),
			showTextDocument: async doc => { shown = doc; },
			showErrorMessage: message => errors.push(message), showInformationMessage: message => infos.push(message) },
	};
	const compiled = new Module(file, module);
	compiled.filename = file; compiled.paths = module.paths;
	const originalRequire = compiled.require.bind(compiled);
	compiled.require = id => id === "vscode" ? vscode : originalRequire(id);
	compiled._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.Controller = AgentController;", file);
	const c = Object.create(compiled.exports.Controller.prototype);
	c.taskCheckpoint = () => journal;
	c.send = () => assert.fail("Inspecting evidence must not dispatch a model");
	c.resetAgentSession = () => assert.fail("Inspecting evidence must not reset the task");
	await check("actual controller opens evidence while work is running, without dispatch or journal changes", async () => {
		const before = fs.readFileSync(journal.file(task.id));
		await c.showTaskEvidence();
		assert.equal(shown.language, "markdown");
		assert.match(shown.content, /Build a booking form/);
		assert.match(shown.content, /running/);
		assert.deepEqual(fs.readFileSync(journal.file(task.id)), before);
		assert.deepEqual(errors, []);
	});
	const { taskReport } = require("./taskReport");
	await check("empty pending actions explicitly disclaim acceptance in their own section", () => {
		assert.deepEqual(journal.read(task.id).pending, []);
		const report = taskReport(journal, task.id);
		const unresolved = report.split("## Unresolved actions\n")[1].split("\n## User updates")[0];
		assert.match(unresolved, /No unresolved actions recorded\./);
		assert.match(unresolved, /This is not an acceptance result\./);
	});
	fs.writeFileSync(path.join(root, "booking #1.txt"), "booking v1");
	journal.notify("item/completed", { threadId: task.threadId, item: { id: "edit", type: "fileChange", changes: [{ path: "booking #1.txt" }] } });
	await check("unchanged evidence has a valid encoded file link", () => {
		const report = taskReport(new TaskContinuity(root), task.id);
		assert.match(report, /file:\/\/\/.*booking%20%231.txt/);
		assert.match(report, /\*\*unchanged\*\*/);
		assert.match(report, new RegExp(journal.evidence("booking #1.txt").sha256));
	});
	await check("fresh invocation detects edits and removes the verified link", () => {
		fs.writeFileSync(path.join(root, "booking #1.txt"), "booking v2");
		const report = taskReport(journal, task.id);
		assert.match(report, /\*\*changed\*\*/); assert.doesNotMatch(report, /file:\/\//);
	});
	await check("missing evidence cannot retain a file link", () => {
		fs.unlinkSync(path.join(root, "booking #1.txt"));
		const report = taskReport(journal, task.id);
		assert.match(report, /\*\*missing\*\*/); assert.doesNotMatch(report, /file:\/\//);
	});
	await check("escaping symlink cannot expose evidence outside the workspace", () => {
		fs.symlinkSync(__filename, path.join(root, "booking #1.txt"));
		const report = taskReport(journal, task.id);
		assert.match(report, /\*\*missing\*\*/); assert.doesNotMatch(report, /file:\/\//);
	});
	await check("report reads current durable events and never promotes heartbeat to progress", () => {
		const disk = journal.read(task.id);
		disk.events.push({ at: "now", type: "heartbeat", command: "SECRET_ARGUMENT" });
		disk.events.push({ at: "now", type: "item/completed", tool: "commandExecution", exitCode: 7, command: "SECRET_ARGUMENT" });
		disk.pending.push({ id: "unknown-command", type: "commandExecution" });
		disk.status = "needs_review"; journal.save(disk);
		const report = taskReport(journal, task.id);
		assert.match(report, /needs\\_review/); assert.match(report, /exit 7/);
		assert.match(report, /unknown-command/); assert.match(report, /outcome unknown/);
		assert.match(report, /does not prove acceptance/);
		assert.doesNotMatch(report, /heartbeat|SECRET_ARGUMENT/);
	});
	await check("saved text cannot inject Markdown commands, HTML or evidence links", () => {
		const disk = journal.read(task.id);
		disk.objective = "[Run](command:evil)\n<img src=x>";
		disk.steering = [{ state: "cancelled", text: "[Fake](file:///private)" }]; journal.save(disk);
		const report = taskReport(journal, task.id);
		assert.ok(report.includes("\\[Run\\]\\(command:evil\\)"));
		assert.ok(report.includes("\\<img src=x\\>"));
		assert.ok(report.includes("\\[Fake\\]\\(file:///private\\)"));
		assert.match(report, /\*\*cancelled\*\*/);
	});
	await check("saved user text strips ANSI escape and carriage return while retaining escaped content", () => {
		const disk = journal.read(task.id);
		disk.objective = "Before\x1b[2Kafter\r[Accept](command:evil)";
		disk.steering = [{ state: "cancelled", text: "Keep\rvisible\x1b[2Kend" }];
		journal.save(disk);
		const before = fs.readFileSync(journal.file(task.id));
		const report = taskReport(new TaskContinuity(root), task.id);
		assert.ok(report.includes("Before \\[2Kafter \\[Accept\\]\\(command:evil\\)"));
		assert.ok(report.includes("Keep visible \\[2Kend"));
		assert.doesNotMatch(report, /[\x00-\x09\x0b-\x1f\x7f]/);
		assert.deepEqual(fs.readFileSync(journal.file(task.id)), before);
	});
	await check("cancelled picker leaves the editor alone", async () => {
		choice = null; shown = null; await c.showTaskEvidence(); assert.equal(shown, null);
	});
	await check("deleted task during selection yields visible error without opening stale content", async () => {
		choice = task.id; shown = null;
		vscode.window.showQuickPick = async rows => { fs.unlinkSync(journal.file(task.id)); return rows[0]; };
		await c.showTaskEvidence(); assert.equal(shown, null); assert.equal(errors.length, 1);
		assert.match(errors[0], /Could not read task evidence/);
	});
	await check("empty workspace explains why there is no report", async () => {
		await c.showTaskEvidence(); assert.equal(infos.length, 1); assert.equal(shown, null);
	});
	console.log(`taskReport.test.js: ${passed}/${passed} checks passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
