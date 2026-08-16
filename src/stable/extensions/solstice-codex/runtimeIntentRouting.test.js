"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { isPureLaunchIntent, isExternalLaunchIntent, runtimeStopIntent } = require("./intent");

let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }

ok(isExternalLaunchIntent("פתח את האתר בדפדפן"), "Hebrew browser request selects the external browser");
ok(isExternalLaunchIntent("תפתח את האתר בכרום"), "Hebrew Chrome request selects the external browser");
ok(isExternalLaunchIntent("open the site in my browser"), "English browser request selects the external browser");
ok(isExternalLaunchIntent("launch the website externally"), "English external request selects the external browser");
ok(!isExternalLaunchIntent("פתח את האתר"), "plain launch request keeps the embedded preview");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const handlerStart = extension.indexOf("\tasync handleRuntimeIntent(text) {");
const handlerEnd = extension.indexOf("\n\tstopPreviewWatch()", handlerStart);
const handler = extension.slice(handlerStart, handlerEnd);
const ensureStart = extension.indexOf("\tasync ensureDevServer(");
const ensureEnd = extension.indexOf("\n\tdevServerIdleTimeoutMs()", ensureStart);
const ensure = extension.slice(ensureStart, ensureEnd);

ok(handlerStart >= 0 && handlerEnd > handlerStart, "runtime intent handler is present");
ok(/isExternalLaunchIntent\(text\)/.test(handler), "runtime handler distinguishes external-browser intent");
ok(/vscode\.env\.openExternal\(vscode\.Uri\.parse\(url\)\)/.test(handler), "external launch calls VS Code openExternal with the live URL");
ok(/if \(!fs\.existsSync\(path\.join\(root, "package\.json"\)\)\)/.test(handler), "missing package.json is handled explicitly");
ok(/await this\.ensureDevServer\(\{ openPreview: !external \}\)/.test(handler), "a package with no detected framework still starts npm run dev");
ok(!/else if \(hasFramework\(root\)\)/.test(handler), "launch routing no longer gates npm run dev on framework detection");
ok(/systemNote[\s\S]*package\.json/.test(handler), "missing package.json is surfaced in Felix chat");

ok(ensureStart >= 0 && ensureEnd > ensureStart, "dev-server launcher is present");
ok(/this\.devServer\.lastError/.test(ensure), "dev-server failure reads the precise recorded cause");
ok(/systemNote[\s\S]*reason/.test(ensure), "dev-server failure cause is posted to Felix chat");
ok(/return url/.test(ensure), "dev-server launcher returns the live URL for external routing");
ok(!/if \(this\.previewUrl\) return/.test(ensure), "a stale preview URL cannot suppress npm run dev");

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
const handlerBody = handler.slice(handler.indexOf(") {") + 3, handler.lastIndexOf("}"));
const runHandler = new AsyncFunction(
	"text", "isPureLaunchIntent", "isExternalLaunchIntent", "workspaceCwd",
	"detectDevServerUrl", "vscode", "fs", "path", "runtimeStopIntent",
	handlerBody,
);
const ensureBody = ensure.slice(ensure.indexOf(") {") + 3, ensure.lastIndexOf("}"));
const runEnsure = new AsyncFunction("options", "workspaceCwd", "DevServer", ensureBody);

(async () => {
	const notes = [];
	let externalCalls = 0;
	let embeddedCalls = 0;
	const controller = {
		previewUrl: "",
		post: (message) => notes.push(message),
		openPreview: async () => { embeddedCalls++; },
		ensureDevServer: async () => { throw new Error("must not start an already-live server"); },
		refreshPreview: () => { },
	};
	const vscode = {
		env: { openExternal: async () => { externalCalls++; return true; } },
		Uri: { parse: (value) => value },
		window: { showWarningMessage: () => { } },
	};
	await runHandler.call(
		controller, "פתח את האתר בדפדפן", isPureLaunchIntent, isExternalLaunchIntent,
		() => "/tmp/project", async () => "http://127.0.0.1:5173/", vscode,
		{ existsSync: () => true }, path, runtimeStopIntent,
	);
	ok(externalCalls === 1, "external browser intent calls openExternal exactly once");
	ok(embeddedCalls === 0, "external browser intent does not open the embedded preview");

	let ensureOptions = null;
	controller.ensureDevServer = async (options) => { ensureOptions = options; controller.previewUrl = "http://127.0.0.1:4173/"; return controller.previewUrl; };
	await runHandler.call(
		controller, "פתח את האתר", isPureLaunchIntent, isExternalLaunchIntent,
		() => "/tmp/project", async () => null, vscode,
		{ existsSync: () => true }, path, runtimeStopIntent,
	);
	ok(ensureOptions && ensureOptions.openPreview === true, "package.json starts npm run dev even without framework detection");

	const failureNotes = [];
	const failingController = {
		previewUrl: "",
		devServer: {
			lastError: "cannot start npm run dev: npm was not found in the Windows PATH, registry PATH, or npm prefix",
			ensure: async () => null,
		},
		post: (message) => failureNotes.push(message),
		pushDevServerInventory: () => { },
	};
	const result = await runEnsure.call(failingController, { openPreview: false }, () => "/tmp/project", function DevServer() { });
	ok(result === null, "npm failure returns no fake preview URL");
	ok(failureNotes.some((message) => message.type === "systemNote" && message.text.includes("npm was not found in the Windows PATH")), "npm resolver failure reaches Felix chat with the exact cause");

	let staleEnsureCalls = 0;
	const staleController = {
		previewUrl: "http://127.0.0.1:3000/",
		devServer: {
			lastError: "",
			ensure: async () => { staleEnsureCalls++; return "http://127.0.0.1:5173/"; },
			touch: () => { },
		},
		post: () => { },
		pushDevServerInventory: () => { },
	};
	const recovered = await runEnsure.call(staleController, { openPreview: false }, () => "/tmp/project", function DevServer() { });
	ok(staleEnsureCalls === 1 && recovered === "http://127.0.0.1:5173/", "stale preview state still verifies or starts the real dev server");

	console.log(`runtimeIntentRouting.test.js: ${checks}/${checks} checks passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
