"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	safeTaskId,
	artifactIndexFile,
	registerArtifact,
	listArtifacts,
	latestGreenSelfCheck,
} = require("./artifactStore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-artifacts-"));
let passed = 0;
function ok(value, label) { assert.ok(value, label); passed++; console.log("ok - " + label); }

try {
	const taskId = safeTaskId("client/alpha build #42");
	ok(taskId === "client-alpha-build-42", "task ids are filesystem-safe and stable");
	const round = path.join(root, ".solstice", "self-check", taskId, "round-2");
	fs.mkdirSync(round, { recursive: true });
	fs.writeFileSync(path.join(round, "report.json"), JSON.stringify({ ok: true, summary: { linksChecked: 2 } }));
	fs.writeFileSync(path.join(round, "desktop.png"), Buffer.from([137, 80, 78, 71]));
	fs.writeFileSync(path.join(round, "mobile.png"), Buffer.from([137, 80, 78, 71, 1]));
	const gate = latestGreenSelfCheck(root, taskId);
	ok(gate && gate.round === 2, "latest green browser gate is resolved by taskId");
	ok(gate.report.summary.linksChecked === 2, "gate report provenance is preserved");

	const dir = path.join(root, ".solstice", "walkthrough", taskId, "run-1");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "WALKTHROUGH.md"), "# fixture\n");
	const saved = registerArtifact(root, { taskId, path: dir, type: "build-walkthrough", markdown: "WALKTHROUGH.md" });
	ok(saved.taskId === taskId && !path.isAbsolute(saved.path), "artifact registry stores a task-bound workspace-relative path");
	ok(fs.existsSync(artifactIndexFile(root)), "artifact index is persisted per project");
	ok(listArtifacts(root, taskId).length === 1, "artifact can be listed by its taskId");
	let escaped = false;
	try { registerArtifact(root, { taskId, path: os.tmpdir() }); } catch { escaped = true; }
	ok(escaped, "artifact registry rejects paths outside the project");
	console.log(`artifactStore.test.js: ${passed}/${passed} checks passed`);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
