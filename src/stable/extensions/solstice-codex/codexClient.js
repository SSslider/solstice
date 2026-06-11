"use strict";
const { spawn } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// JSON-RPC 2.0 over line-delimited JSON on stdio of `codex app-server`.
class CodexClient {
	constructor(opts) {
		this.opts = opts; // { binPath, codexHome, onNotification, onServerRequest, onExit, log }
		this.child = null;
		this.nextId = 1;
		this.pending = new Map();
	}

	get running() {
		return !!this.child && this.child.exitCode === null;
	}

	start() {
		if (this.running) return;
		const env = { ...process.env };
		if (this.opts.codexHome) env.CODEX_HOME = this.opts.codexHome;
		this.child = spawn(this.opts.binPath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env });
		const rl = readline.createInterface({ input: this.child.stdout });
		rl.on("line", (line) => this._onLine(line));
		this.child.stderr.on("data", (d) => this.opts.log && this.opts.log(String(d)));
		this.child.on("exit", (code) => {
			for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
			this.pending.clear();
			this.child = null;
			if (this.opts.onExit) this.opts.onExit(code);
		});
	}

	stop() {
		if (this.child) this.child.kill();
	}

	_onLine(line) {
		let msg;
		try { msg = JSON.parse(line); } catch { return; }
		// response to one of our requests
		if (msg.id !== undefined && msg.method === undefined) {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
				else p.resolve(msg.result);
			}
			return;
		}
		// server -> client request (approvals etc.)
		if (msg.id !== undefined && msg.method !== undefined) {
			Promise.resolve(this.opts.onServerRequest(msg.method, msg.params))
				.then((result) => this._send({ jsonrpc: "2.0", id: msg.id, result }))
				.catch((e) => this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e && e.message || e) } }));
			return;
		}
		if (msg.method !== undefined && this.opts.onNotification) this.opts.onNotification(msg.method, msg.params);
	}

	_send(obj) {
		if (!this.running) return;
		this.child.stdin.write(JSON.stringify(obj) + "\n");
	}

	request(method, params) {
		return new Promise((resolve, reject) => {
			if (!this.running) return reject(new Error("codex app-server not running"));
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			this._send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method, params) {
		this._send({ jsonrpc: "2.0", method, params });
	}
}

// Resolution order: explicit setting -> bundled binary -> PATH.
function resolveCodexBinary(extensionPath, configuredPath) {
	if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
	const exe = process.platform === "win32" ? "codex.exe" : "codex";
	const bundled = path.join(extensionPath, "bin", exe);
	if (fs.existsSync(bundled)) return bundled;
	return "codex";
}

module.exports = { CodexClient, resolveCodexBinary };
