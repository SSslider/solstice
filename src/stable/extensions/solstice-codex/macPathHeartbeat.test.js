"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { whichFull, extraUnixDirs } = require("./winspawn");
const { createStartupHeartbeat, GROK_STARTUP_HEARTBEAT_MS } = require("./grok");

async function main() {
	assert.equal(GROK_STARTUP_HEARTBEAT_MS, 20000);
	assert.ok(extraUnixDirs().includes("/opt/homebrew/bin"));
	assert.ok(extraUnixDirs().includes("/opt/homebrew/sbin"));

	// Simulate a GUI-launched macOS process: minimal PATH, but Homebrew owns grok.
	const oldPath = process.env.PATH;
	const oldExists = fs.existsSync;
	process.env.PATH = "/usr/bin:/bin";
	fs.existsSync = (candidate) => candidate === path.join("/opt/homebrew/bin", "grok") || oldExists(candidate);
	try {
		assert.equal(whichFull("grok"), path.join("/opt/homebrew/bin", "grok"));
	} finally {
		fs.existsSync = oldExists;
		process.env.PATH = oldPath;
	}

	let warnings = 0;
	await new Promise((resolve) => {
		createStartupHeartbeat(() => { warnings++; resolve(); }, 10);
	});
	assert.equal(warnings, 1);
	const heartbeat = createStartupHeartbeat(() => { warnings++; }, 10);
	heartbeat.pulse();
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(warnings, 1);

	console.log("macPathHeartbeat.test.js: 8/8 checks passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
