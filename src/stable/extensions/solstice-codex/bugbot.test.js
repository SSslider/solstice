"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseFindings, runBugbot } = require("./bugbot");

const findings = parseFindings('```json\n{"findings":[{"severity":"HIGH","file":"src/a.js","line":12,"message":"Race drops the stop request."},{"file":"src/b.js","line":0,"message":"Unhandled null."}]}\n```');
assert.equal(findings.length, 2);
assert.equal(findings[0].severity, "high");
assert.equal(findings[0].line, 12);
assert.equal(findings[1].severity, "medium");
assert.equal(findings[1].line, 1);
assert.deepEqual(parseFindings("not json"), []);
assert.deepEqual(parseFindings('{"findings":[]}'), []);

async function codexReviewUsesDiscoveredDefault() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-bugbot-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "bugbot@test.invalid"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Bugbot Test"], { cwd: root });
		fs.writeFileSync(path.join(root, "app.js"), "module.exports = 1;\n");
		execFileSync("git", ["add", "app.js"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
		fs.writeFileSync(path.join(root, "app.js"), "module.exports = 2;\n");

		const calls = [];
		let stopped = false;
		const fakeClient = {
			start() { calls.push(["start"]); },
			notify(method, params) { calls.push(["notify", method, params]); },
			async request(method, params) {
				calls.push(["request", method, params]);
				if (method === "thread/start") return { thread: { id: "bugbot-thread" } };
				if (method === "turn/start") {
					queueMicrotask(() => {
						fakeClient.opts.onNotification("item/agentMessage/delta", { threadId: "bugbot-thread", delta: '{"findings":[]}' });
						fakeClient.opts.onNotification("turn/completed", { threadId: "bugbot-thread" });
					});
				}
				return {};
			},
			stop() { stopped = true; },
		};
		const result = await runBugbot(root, {
			model: "gpt-5.6-sol",
			createClient: (opts) => { fakeClient.opts = opts; return fakeClient; },
			timeoutMs: 1000,
		});
		const threadStart = calls.find((call) => call[0] === "request" && call[1] === "thread/start");
		assert.ok(threadStart, "starts a dedicated Codex review thread");
		assert.equal(threadStart[2].model, "gpt-5.6-sol", "uses the default reported by Codex discovery");
		assert.equal(threadStart[2].approvalPolicy, "never", "review cannot request mutation approval");
		assert.equal(threadStart[2].sandbox, "read-only", "review runs read-only");
		assert.ok(calls.some((call) => call[1] === "turn/start"), "runs the review turn");
		assert.deepEqual(result.findings, []);
		assert.equal(stopped, true, "stops the dedicated review process");
		assert.ok(!calls.some((call) => JSON.stringify(call).includes("composer-2.5")), "never routes review through Composer");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

codexReviewUsesDiscoveredDefault().then(() => {
	console.log("bugbot.test.js: 15/15 checks passed");
}).catch((error) => {
	console.error(error && error.stack || error);
	process.exitCode = 1;
});
