"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const APPROVAL_URL_ENV = "SOLSTICE_GROK_APPROVAL_URL";
const APPROVAL_TOKEN_ENV = "SOLSTICE_GROK_APPROVAL_TOKEN";
const HOOK_FILE_NAME = "solstice-felix-approval.json";
const SAFE_GROK_TOOLS = new Set([
	"read_file",
	"list_dir",
	"grep",
	"web_search",
	"web_fetch",
	"view_image",
	"todo_write",
	"create_plan",
	"ask_question",
	"switch_mode",
	"await",
	"get_command_or_subagent_output",
	"wait_commands_or_subagents",
	"invoke_skill",
]);

function readBody(req, limit = 128 * 1024) {
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

function toolNameOf(input) {
	return String(input && (input.toolName || input.tool_name) || "unknown").trim();
}

function isSafeGrokTool(input) {
	return SAFE_GROK_TOOLS.has(toolNameOf(input).toLowerCase());
}

function grokApprovalDescriptor(input, threadId) {
	const toolName = toolNameOf(input);
	const lower = toolName.toLowerCase();
	const toolInput = input && (input.toolInput || input.tool_input) || {};
	const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
	const reason = String(toolInput.description || toolInput.reason || `Grok requested ${toolName}`).slice(0, 1000);
	const params = {
		threadId,
		source: "grok",
		oneShotOnly: true,
		toolName,
		toolInput,
		reason,
	};
	if (command) params.command = command;
	if (/^(?:run_terminal_command|shell|bash)$/.test(lower)) {
		return { method: "item/commandExecution/requestApproval", params };
	}
	if (/^(?:search_replace|write|edit|str_replace|apply_patch|edit_notebook|delete)$/.test(lower)) {
		params.localFileEdit = true;
		return { method: "item/fileChange/requestApproval", params };
	}
	if (lower === "call_mcp_tool" || lower.includes("__")) {
		params.serverName = lower === "call_mcp_tool"
			? String(toolInput.server || toolInput.serverName || "MCP")
			: toolName.split("__", 1)[0];
		return { method: "mcpServer/elicitation/request", params };
	}
	return { method: "item/permissions/requestApproval", params };
}

class GrokApprovalBridge {
	constructor(opts = {}) {
		this.authorize = opts.authorize || (async () => ({ decision: "deny", reason: "approval_not_configured" }));
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
				if (!sameToken(req.headers["x-solstice-approval-token"], this.token)) return reply(403, { decision: "deny", reason: "forbidden" });
				if (req.method !== "POST" || req.url !== "/approval") return reply(404, { decision: "deny", reason: "not_found" });
				try {
					const input = JSON.parse(await readBody(req) || "{}");
					const result = await this.authorize(input);
					const decision = result && result.decision === "allow" ? "allow" : "deny";
					return reply(200, { decision, reason: result && result.reason || undefined });
				} catch (error) {
					this.log(`[grok-approval] ${error && error.message || error}\n`);
					return reply(200, { decision: "deny", reason: "Felix approval bridge failed closed." });
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
		return this.url ? { [APPROVAL_URL_ENV]: this.url, [APPROVAL_TOKEN_ENV]: this.token } : {};
	}

	close() {
		if (this.server) this.server.close();
		this.server = null;
		this.url = "";
	}
}

function quoteArg(value) {
	return `"${String(value).replace(/"/g, '\\"')}"`;
}

function hookCommand(executable, script, platform = process.platform) {
	if (platform === "win32") {
		return `cmd /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ""${executable}"" ""${script}"""`;
	}
	return `ELECTRON_RUN_AS_NODE=1 ${quoteArg(executable)} ${quoteArg(script)}`;
}

function installGrokApprovalHook(opts = {}) {
	const homeDir = opts.homeDir || os.homedir();
	const hooksDir = path.join(homeDir, ".grok", "hooks");
	const hookFile = path.join(hooksDir, HOOK_FILE_NAME);
	const script = opts.script || path.join(opts.extensionPath || "", "grokApprovalHook.js");
	const executable = opts.executable || process.execPath;
	const config = {
		hooks: {
			PreToolUse: [{
				hooks: [{
					type: "command",
					command: hookCommand(executable, script, opts.platform),
					timeout: 1800,
				}],
			}],
		},
	};
	fs.mkdirSync(hooksDir, { recursive: true });
	const body = JSON.stringify(config, null, 2) + "\n";
	let current = "";
	try { current = fs.readFileSync(hookFile, "utf8"); } catch { }
	if (current !== body) {
		const tmp = `${hookFile}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, body, "utf8");
		fs.renameSync(tmp, hookFile);
	}
	return hookFile;
}

module.exports = {
	APPROVAL_TOKEN_ENV,
	APPROVAL_URL_ENV,
	GrokApprovalBridge,
	grokApprovalDescriptor,
	hookCommand,
	installGrokApprovalHook,
	isSafeGrokTool,
};
