"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { GrokProvider } = require("./grok");
const { isPureLaunchIntent, isPureStopRuntimeIntent } = require("./intent");
const { DevServer } = require("./preview");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-followup-"));
const prompts = [];
function fakeSpawn(_cmd, args) {
	const child = new EventEmitter();
	child.pid = 4242;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => { };
	if (args[0] === "models") {
		setImmediate(() => {
			child.stdout.emit("data", Buffer.from("Available models:\n  * grok-4.5 (default)\n  - grok-composer-2.5-fast\n"));
			child.emit("close", 0);
		});
		return child;
	}
	const promptFile = args[args.indexOf("--prompt-file") + 1];
	prompts.push(fs.readFileSync(promptFile, "utf8"));
	setImmediate(() => {
		child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", data: "applied" }) + "\n"));
		child.emit("close", 0);
	});
	return child;
}

(async () => {
	const provider = new GrokProvider({ cwd: root, bin: "fake-grok", spawn: fakeSpawn, notify: () => { } });
	await provider.send("grok-4.5", "[FELIX_PROJECT_BRAIN]\nlarge injected context\n[/FELIX_PROJECT_BRAIN]\nBuild the first site", "system", { userText: "Build the first site" });
	await provider.send("grok-4.5", "[FELIX_PROJECT_BRAIN]\nlarge injected context again\n[/FELIX_PROJECT_BRAIN]\nChange the hero to blue", "system", { userText: "Change the hero to blue" });

	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /^\[FELIX_CURRENT_REQUEST\]\nChange the hero to blue/);
	assert.match(prompts[1], /User request: Build the first site/);
	assert.match(prompts[1], /Current request \(execute before narrating\): Change the hero to blue$/);
	assert.ok(!provider.history.some((entry) => entry.text.includes("FELIX_PROJECT_BRAIN")), "history stores clean requests, not injected context");
	assert.equal(provider.history[0].text, "Build the first site");
	assert.equal(provider.history[2].text, "Change the hero to blue");
	assert.equal(isPureLaunchIntent("פתח את האתר"), true);
	assert.equal(isPureStopRuntimeIntent("תעשה terminate לפרוסס של האתר"), true);
	assert.equal(isPureStopRuntimeIntent("תקן את כפתור ה-stop באתר"), false);

	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	assert.equal((extension.match(/\n\trefreshPreview\(\) \{/g) || []).length, 1, "single refreshPreview implementation");
	assert.match(extension, /sendGrok\(text, rawText\)/);
	assert.match(extension, /handleRuntimeIntent\(rawText\)/);

	let killedWith = "";
	const dev = new DevServer(root);
	dev.url = "http://127.0.0.1:5173";
	dev.proc = { pid: 5151, exitCode: null, kill: (signal) => { killedWith = signal; } };
	assert.equal(dev.hasOwnedProcess(), true);
	assert.deepEqual(dev.stop(), { stopped: true, pid: 5151 });
	assert.equal(killedWith, "SIGTERM");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("followupContinuity.test.js: 15/15 checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
