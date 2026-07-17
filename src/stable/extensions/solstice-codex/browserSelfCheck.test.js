"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	safeId,
	normalizeBrowserReport,
	selfCheckRoundDir,
	writeBrowserSelfCheckReport,
	buildBrowserFixPrompt,
} = require("./browserSelfCheck");

let passed = 0;
function ok(value, label) { assert.ok(value, label); passed++; console.log("ok - " + label); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-self-check-test-"));
try {
	ok(safeId("task / ../../escape") === "task-..-..-escape", "build id is filesystem-safe");
	ok(selfCheckRoundDir(root, "task", 2).endsWith(path.join("task", "round-2")), "round directory is deterministic");
	const red = normalizeBrowserReport({ ok: true, findings: [{ severity: "error", check: "404", message: "missing" }] });
	ok(red.ok === false, "an error cannot be normalized as green");
	ok(red.findings[0].check === "404", "finding category survives normalization");
	const green = normalizeBrowserReport({ ok: true, summary: { linksChecked: 2 }, findings: [{ severity: "warning", check: "form", message: "file input skipped" }] });
	ok(green.ok === true, "warnings do not fail the browser gate");
	ok(green.summary.linksChecked === 2, "browser coverage summary survives normalization");
	const saved = writeBrowserSelfCheckReport(root, "build-1", 1, red);
	ok(fs.existsSync(saved.file), "round report is persisted");
	ok(fs.existsSync(saved.latest), "latest report pointer is persisted");
	ok(JSON.parse(fs.readFileSync(saved.file, "utf8")).round === 1, "persisted report records its round");
	const prompt = buildBrowserFixPrompt(red, 1, 3);
	ok(prompt.includes("[404] missing"), "fix prompt contains the concrete finding");
	ok(prompt.includes("round 1/3"), "fix prompt states the bounded retry round");
	ok(prompt.includes("Do not claim delivery is complete"), "fix prompt blocks a false done claim");
	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	const browse = fs.readFileSync(path.join(__dirname, "webtools", "browse.js"), "utf8");
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
ok(extension.includes("browserCheckStarted = this.maybeRunBrowserSelfCheck()"), "turn completion is held behind the browser gate");
ok(extension.includes("this.isBuildIntent(text) || browserBuildIntent"), "browser follow-up edits enter the same build and QA flow");
ok(extension.includes("add|change|update|polish|style|refactor"), "browser follow-up mutation verbs arm the QA gate");
ok(extension.includes("await this.send(fixPrompt)"), "red browser findings trigger an automatic fix turn");
	ok(extension.includes('method === "turn/engineFailed"'), "repair-engine exits are captured before turn completion");
	ok(extension.includes('check: "repair-engine"'), "repair-engine exits become concrete browser findings");
	ok(extension.includes("state.pendingEngineFailure = \"\""), "recorded engine failures are consumed once before the next repair round");
	ok(extension.includes("state.round >= state.maxRounds"), "auto-fix loop has a hard convergence bound");
	ok(extension.includes("this._verifyTaskId = state.id"), "green browser result feeds the existing verified delivery chain");
	ok(browse.includes('Input.dispatchMouseEvent'), "functional check performs real browser clicks");
	ok(browse.includes('Network.responseReceived'), "functional check captures HTTP failures");
ok(browse.includes('Runtime.exceptionThrown'), "functional check captures runtime exceptions");
ok(browse.includes('Fetch.fulfillRequest'), "functional check stubs mutating browser requests before network side effects");
ok(browse.includes('Mobile horizontal overflow'), "functional check includes a mobile layout pass");
	ok(extension.includes("siteReplicaSourceUrl(task)"), "clone intent arms the browser gate with its source URL");
	ok(extension.includes('"replica-compare"'), "green functional QA runs the replica visual comparison automatically");
	ok(extension.includes('check: "visual-fidelity"'), "sub-80 replica evidence becomes a concrete browser-gate failure");
	ok(extension.includes("SOLSTICE_SITE_REPLICA_CONTRACT"), "clone requests receive the authorized no-code-copy rebuild contract");
	ok(extension.includes('"Confirm authorized source"'), "bare clone URLs stop at an explicit authorization modal");
	ok(manifest.contributes.configuration.properties["solstice.codex.selfVerify"].description.includes("three rounds"), "user-facing setting describes the bounded browser loop");
	console.log(`browserSelfCheck.test.js: ${passed}/${passed} checks passed`);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
