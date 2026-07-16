"use strict";

const crypto = require("crypto");
const http = require("http");

const TOOL_URL_ENV = "SOLSTICE_DEV_SERVER_TOOL_URL";
const TOOL_TOKEN_ENV = "SOLSTICE_DEV_SERVER_TOOL_TOKEN";
const SAFE_SERVER_ID = /^(?:workspace|manager:[A-Za-z0-9._-]+)$/;

function serverEntry(id, scope, server, taskId) {
	if (!server || typeof server.hasOwnedProcess !== "function" || !server.hasOwnedProcess()) return null;
	return {
		id,
		scope,
		taskId: taskId || null,
		root: server.root || null,
		pid: server.proc && server.proc.pid || null,
		port: server.port || null,
		url: server.url || (server.port ? `http://127.0.0.1:${server.port}` : null),
		ownedBySolstice: true,
	};
}

function listOwnedDevServers(workspaceServer, managerServers) {
	const entries = [];
	const workspace = serverEntry("workspace", "workspace", workspaceServer);
	if (workspace) entries.push(workspace);
	for (const [taskId, server] of managerServers || []) {
		const item = serverEntry(`manager:${taskId}`, "manager", server, taskId);
		if (item) entries.push(item);
	}
	return entries;
}

function stopOwnedDevServer(workspaceServer, managerServers, id) {
	const target = String(id || "workspace");
	if (!SAFE_SERVER_ID.test(target)) return { ok: false, error: "invalid_server_id", id: target };
	let server = null;
	let scope = "workspace";
	let taskId = null;
	if (target === "workspace") server = workspaceServer;
	else {
		scope = "manager";
		taskId = target.slice("manager:".length);
		server = managerServers && managerServers.get(taskId);
	}
	if (!server || typeof server.hasOwnedProcess !== "function" || !server.hasOwnedProcess()) {
		return { ok: false, error: "owned_server_not_running", id: target };
	}
	const before = serverEntry(target, scope, server, taskId);
	const stopped = server.stop();
	return {
		ok: !!(stopped && stopped.stopped),
		id: target,
		scope,
		taskId,
		pid: stopped && stopped.pid || before && before.pid || null,
		root: before && before.root || null,
		error: stopped && stopped.stopped ? undefined : "stop_failed",
	};
}

function readBody(req, limit = 16 * 1024) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > limit) reject(new Error("request_too_large"));
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function sameToken(actual, expected) {
	const a = Buffer.from(String(actual || ""));
	const b = Buffer.from(String(expected || ""));
	return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

class DevServerToolBridge {
	constructor(opts = {}) {
		this.list = opts.list || (() => []);
		this.stop = opts.stop || (() => ({ ok: false, error: "not_configured" }));
		this.log = opts.log || (() => { });
		this.token = crypto.randomBytes(24).toString("hex");
		this.server = null;
		this.url = "";
		this.starting = null;
	}

	async start() {
		if (this.url) return this.env();
		if (this.starting) return this.starting;
		this.starting = new Promise((resolve, reject) => {
			const server = http.createServer(async (req, res) => {
				const reply = (status, value) => {
					res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
					res.end(JSON.stringify(value));
				};
				if (!sameToken(req.headers["x-solstice-tool-token"], this.token)) return reply(403, { ok: false, error: "forbidden" });
				if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" });
				try {
					const body = JSON.parse(await readBody(req) || "{}");
					if (req.url === "/solstice/dev-server-list") {
						const servers = await this.list();
						return reply(200, { ok: true, servers });
					}
					if (req.url === "/solstice/dev-server-stop") {
						const result = await this.stop(body.id || "workspace");
						return reply(result && result.ok ? 200 : 409, result || { ok: false, error: "stop_failed" });
					}
					return reply(404, { ok: false, error: "unknown_tool" });
				} catch (error) {
					this.log(`[dev-tools] ${error && error.message || error}\n`);
					return reply(400, { ok: false, error: error && error.message || "bad_request" });
				}
			});
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				this.server = server;
				this.url = `http://127.0.0.1:${address.port}`;
				server.unref && server.unref();
				resolve(this.env());
			});
		});
		try { return await this.starting; }
		finally { this.starting = null; }
	}

	env() {
		return this.url ? { [TOOL_URL_ENV]: this.url, [TOOL_TOKEN_ENV]: this.token } : {};
	}

	close() {
		if (this.server) this.server.close();
		this.server = null;
		this.url = "";
	}
}

function requestTool(name, args = {}, env = process.env) {
	return new Promise((resolve, reject) => {
		const base = env[TOOL_URL_ENV];
		const token = env[TOOL_TOKEN_ENV];
		if (!base || !token) return reject(new Error("Solstice dev-server tools are unavailable outside the running IDE."));
		const url = new URL(`/solstice/${name}`, base);
		const body = JSON.stringify(args);
		const req = http.request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
				"x-solstice-tool-token": token,
			},
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => {
				let parsed;
				try { parsed = JSON.parse(text || "{}"); } catch { return reject(new Error(`Invalid Solstice tool response (${res.statusCode}).`)); }
				if (res.statusCode >= 400 || !parsed.ok) return reject(Object.assign(new Error(parsed.error || `tool_failed_${res.statusCode}`), { result: parsed }));
				resolve(parsed);
			});
		});
		req.setTimeout(5000, () => req.destroy(new Error("Solstice dev-server tool timed out.")));
		req.on("error", reject);
		req.end(body);
	});
}

function quoteArg(value) {
	return `"${String(value).replace(/"/g, '\\"')}"`;
}

function agentToolCommand(executable, script, operation, id, platform = process.platform) {
	if (!/^(list|stop)$/.test(operation)) throw new Error("invalid operation");
	if (id != null && !SAFE_SERVER_ID.test(String(id))) throw new Error("invalid server id");
	const tail = [operation, id].filter((v) => v != null).join(" ");
	if (platform === "win32") {
		return `cmd /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ""${executable}"" ""${script}"" ${tail}"`;
	}
	return `ELECTRON_RUN_AS_NODE=1 ${quoteArg(executable)} ${quoteArg(script)} ${tail}`;
}

function commandStrings(value, key = "", depth = 0, out = []) {
	if (value == null || depth > 5) return out;
	if (typeof value === "string") {
		if (/command|cmd|argv|args/i.test(key)) out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		if (/command|cmd|argv|args/i.test(key) && value.every((item) => typeof item === "string")) out.push(value.join(" "));
		for (const item of value) commandStrings(item, key, depth + 1, out);
		return out;
	}
	if (typeof value === "object") for (const [k, v] of Object.entries(value)) commandStrings(v, k, depth + 1, out);
	return out;
}

function isSafeDevServerToolApproval(params, executable, script, platform = process.platform) {
	for (const command of commandStrings(params)) {
		if (command === agentToolCommand(executable, script, "list", null, platform)) return true;
		const id = command.match(/(?:workspace|manager:[A-Za-z0-9._-]+)(?="?\s*$)/);
		if (id && command === agentToolCommand(executable, script, "stop", id[0], platform)) return true;
	}
	return false;
}

async function cliMain(argv = process.argv.slice(2)) {
	const operation = argv[0];
	if (operation === "list") return requestTool("dev-server-list");
	if (operation === "stop") {
		const id = argv[1] || "workspace";
		if (!SAFE_SERVER_ID.test(id)) throw new Error("Server id must be 'workspace' or 'manager:<task-id>'.");
		return requestTool("dev-server-stop", { id });
	}
	throw new Error("Usage: devServerTools.js list | stop [workspace|manager:<task-id>]");
}

if (require.main === module) {
	cliMain()
		.then((result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
		.catch((error) => {
			process.stderr.write(`Error: ${error && error.message || error}\n`);
			process.exitCode = 1;
		});
}

module.exports = {
	DevServerToolBridge,
	agentToolCommand,
	cliMain,
	isSafeDevServerToolApproval,
	listOwnedDevServers,
	requestTool,
	stopOwnedDevServer,
	TOOL_TOKEN_ENV,
	TOOL_URL_ENV,
};
