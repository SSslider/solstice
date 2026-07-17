"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { GrokProvider, GROK_MODELS, chooseLiveGrokModel } = require("./grok");

const live = [
	{ modelId: "grok-4.5" },
	{ modelId: "grok-composer-2.5-fast" },
];
assert.deepEqual(chooseLiveGrokModel("grok-4.5", live), {
	id: "grok-4.5", fallback: false, live: ["grok-4.5", "grok-composer-2.5-fast"],
});
assert.deepEqual(chooseLiveGrokModel("grok-9.9", live), {
	id: "grok-4.5", fallback: true, live: ["grok-4.5", "grok-composer-2.5-fast"],
});
assert.equal(chooseLiveGrokModel("grok-composer-3-fast", live).id, "grok-composer-2.5-fast");
assert.deepEqual(chooseLiveGrokModel("grok-composer-2.5-fast", [{ modelId: "grok-4.5", isDefault: true }]), {
	id: "grok-4.5", fallback: true, live: ["grok-4.5"],
});

function child() {
	const value = new EventEmitter();
	value.pid = 7711;
	value.stdout = new EventEmitter();
	value.stderr = new EventEmitter();
	value.kill = () => { };
	return value;
}

function modelList(value) {
	setImmediate(() => {
		value.stdout.emit("data", Buffer.from("Available models:\n  * grok-4.5 (default)\n"));
		value.emit("close", 0);
	});
}

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-grok-model-fallback-"));
	const spawnedModels = [];
	const notices = [];
	const fallbackSpawn = (_cmd, args) => {
		const value = child();
		if (args[0] === "models") modelList(value);
		else {
			spawnedModels.push(args[args.indexOf("-m") + 1]);
			setImmediate(() => {
				value.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", data: "fixed" }) + "\n"));
				value.emit("close", 0);
			});
		}
		return value;
	};
	const fallbackProvider = new GrokProvider({
		cwd: root,
		bin: "fake-grok",
		spawn: fallbackSpawn,
		notify: (method, params) => notices.push({ method, params }),
	});
	GROK_MODELS["future-build-key"] = { id: "grok-9.9", label: "Future Grok Build" };
	await fallbackProvider.send("future-build-key", "repair", "system", { userText: "repair" });
	delete GROK_MODELS["future-build-key"];
	assert.deepEqual(spawnedModels, ["grok-4.5"]);
	assert.ok(notices.some((event) => event.method === "item/completed" && /live `grok models` list/.test(event.params.item.text)));

	const composerModels = [];
	const composerProvider = new GrokProvider({
		cwd: root,
		bin: "fake-grok",
		spawn: (_cmd, args) => {
			const value = child();
			if (args[0] === "models") modelList(value);
			else {
				composerModels.push(args[args.indexOf("-m") + 1]);
				setImmediate(() => value.emit("close", 0));
			}
			return value;
		},
		notify: () => { },
	});
	await composerProvider.send("composer-2.5", "repair", "system", { userText: "repair" });
	assert.deepEqual(composerModels, ["grok-4.5"]);

	const failures = [];
	const failingSpawn = (_cmd, args) => {
		const value = child();
		if (args[0] === "models") modelList(value);
		else setImmediate(() => {
			value.stderr.emit("data", Buffer.from("Couldn't set model 'grok-4.5': Invalid params\n"));
			value.emit("close", 1);
		});
		return value;
	};
	const failingProvider = new GrokProvider({
		cwd: root,
		bin: "fake-grok",
		spawn: failingSpawn,
		notify: (method, params) => failures.push({ method, params }),
	});
	await failingProvider.send("grok-4.5", "repair", "system", { userText: "repair" });
	const engineFailure = failures.find((event) => event.method === "turn/engineFailed");
	assert.ok(engineFailure);
	assert.match(engineFailure.params.error.message, /Live `grok models`: grok-4\.5/);
	assert.ok(failures.some((event) => event.method === "turn\/completed"));

	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	assert.match(extension, /check: "repair-engine"/);
	assert.match(extension, /state\.pendingEngineFailure/);
	assert.equal(extension.includes(`"${["grok", "build"].join("-")}"`), false);

	fs.rmSync(root, { recursive: true, force: true });
	console.log("grokModelFallback.test.js: 14/14 checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
