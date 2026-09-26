"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const states = new WeakMap();
const STDERR_BYTES = 4096;

// Keep startup diagnostics with the child, including errors emitted before the
// caller starts waiting. Always drain stderr, but never retain an unbounded log.
function spawnBrowser(bin, args, options = {}) {
	const child = spawn(bin, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });
	const state = { bin, error: null, closed: false, code: null, signal: null, stderr: Buffer.alloc(0) };
	states.set(child, state);
	child.on("error", (error) => { state.error = error; });
	child.on("close", (code, signal) => { state.closed = true; state.code = code; state.signal = signal; });
	child.stderr.on("data", (data) => {
		state.stderr = Buffer.concat([state.stderr, data]).subarray(-STDERR_BYTES);
	});
	return child;
}

function diagnostic(state, reason) {
	const stderr = state.stderr.toString("utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
	return new Error(`Browser startup failed (${state.bin}): ${reason}${stderr ? "\n" + stderr : ""}. Check the browser installation and launch permissions; SOLSTICE_BROWSER can select an installed executable.`);
}

async function waitForDevTools(child, profile, timeoutMs = 10000) {
	const state = states.get(child);
	if (!state) throw new Error("Browser child was not started by spawnBrowser");
	const started = Date.now();
	const portFile = path.join(profile, "DevToolsActivePort");
	while (true) {
		if (state.error) throw diagnostic(state, `${state.error.code || "spawn error"}: ${state.error.message}`);
		if (state.closed) throw diagnostic(state, state.signal ? `signal ${state.signal}` : `exit ${state.code}`);
		try {
			const value = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0];
			const port = /^\d+$/.test(value) ? Number(value) : 0;
			if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
		} catch { }
		if (Date.now() - started >= timeoutMs) throw diagnostic(state, `DevTools port not available after ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function detachBrowser(child) {
	// A piped diagnostic stream must not keep the CLI alive after "keep open".
	if (child.stderr && child.stderr.unref) child.stderr.unref();
	child.unref();
}

module.exports = { spawnBrowser, waitForDevTools, detachBrowser };
