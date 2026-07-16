"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
	APPROVAL_TOKEN_ENV,
	APPROVAL_URL_ENV,
	GrokApprovalBridge,
	grokApprovalDescriptor,
	hookCommand,
	installGrokApprovalHook,
	isSafeGrokTool,
} = require("./grokApprovalBridge");
const { requestGrokApproval } = require("./grokApprovalHook");

let checks = 0;
function ok(value, message) {
	checks++;
	assert.ok(value, message);
}

function post(base, token, input) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(input || {});
		const req = http.request(new URL("/approval", base), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
				"x-solstice-approval-token": token,
			},
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

(async () => {
	const safe = ["read_file", "list_dir", "grep", "web_search", "todo_write", "view_image", "create_plan", "ask_question"];
	for (const toolName of safe) ok(isSafeGrokTool({ toolName }), `${toolName} is card-free`);
	ok(!isSafeGrokTool({ toolName: "run_terminal_command" }), "shell is not globally safe");
	ok(!isSafeGrokTool({ toolName: "search_replace" }), "file edit is not globally safe");
	ok(!isSafeGrokTool({ toolName: "higgsfield__generate_video" }), "paid MCP is not globally safe");

	const command = grokApprovalDescriptor({ toolName: "run_terminal_command", toolInput: { command: "npm test", description: "Run tests" } }, "grok-1");
	ok(command.method === "item/commandExecution/requestApproval", "shell maps to command approval");
	ok(command.params.command === "npm test", "command text reaches the card");
	ok(command.params.threadId === "grok-1", "thread ownership is preserved");
	ok(command.params.oneShotOnly === true, "Grok cards are honestly one-shot");

	const edit = grokApprovalDescriptor({ toolName: "search_replace", toolInput: { path: "src/app.js" } }, "grok-2");
	ok(edit.method === "item/fileChange/requestApproval", "edit maps to file approval");
	ok(edit.params.toolInput.path === "src/app.js", "edit detail reaches the card");
	ok(edit.params.localFileEdit === true, "local proposal copy cannot masquerade as a paid provider call");

	const mcp = grokApprovalDescriptor({ toolName: "higgsfield__generate_video", toolInput: { prompt: "X-Field video" } }, "grok-3");
	ok(mcp.method === "mcpServer/elicitation/request", "MCP maps to elicitation approval");
	ok(mcp.params.serverName === "higgsfield", "MCP server is named on the card");

	const generic = grokApprovalDescriptor({ toolName: "generate_image", toolInput: { prompt: "portrait" } }, "grok-4");
	ok(generic.method === "item/permissions/requestApproval", "other side effects use permission approval");

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-grok-approval-test-"));
	const hookFile = installGrokApprovalHook({
		homeDir: root,
		executable: "/opt/Solstice/Solstice",
		script: "/opt/Solstice/grokApprovalHook.js",
		platform: "linux",
	});
	ok(fs.existsSync(hookFile), "global Grok hook config is installed");
	const hookConfig = JSON.parse(fs.readFileSync(hookFile, "utf8"));
	const hook = hookConfig.hooks.PreToolUse[0].hooks[0];
	ok(hook.type === "command", "hook uses a blocking command");
	ok(hook.timeout === 1800, "approval wait fits the Grok turn budget");
	ok(hook.command.includes("grokApprovalHook.js"), "hook invokes the bundled bridge client");
	ok(hook.command.includes("ELECTRON_RUN_AS_NODE=1"), "packaged Electron runs the hook as Node");
	ok(!fs.readFileSync(hookFile, "utf8").includes("SOLSTICE_GROK_APPROVAL_TOKEN"), "hook file persists no bearer token");
	const before = fs.statSync(hookFile).mtimeMs;
	installGrokApprovalHook({ homeDir: root, executable: "/opt/Solstice/Solstice", script: "/opt/Solstice/grokApprovalHook.js", platform: "linux" });
	ok(fs.statSync(hookFile).mtimeMs === before, "unchanged hook config is not rewritten every turn");
	ok(hookCommand("C:\\Solstice\\Solstice.exe", "C:\\Solstice\\grokApprovalHook.js", "win32").startsWith("cmd /d /s /c"), "Windows hook uses the packaged executable safely");

	const seen = [];
	const bridge = new GrokApprovalBridge({ authorize: async (input) => {
		seen.push(input);
		return { decision: input.toolName === "search_replace" ? "allow" : "deny", reason: "test-policy" };
	} });
	const env = await bridge.start();
	ok(env[APPROVAL_URL_ENV].startsWith("http://127.0.0.1:"), "bridge binds loopback on a random port");
	ok(env[APPROVAL_TOKEN_ENV].length === 48, "bridge token has 192 bits of entropy");
	const allowed = await requestGrokApproval({ toolName: "search_replace" }, env);
	ok(allowed.decision === "allow", "hook receives an allow decision before execution");
	const denied = await requestGrokApproval({ toolName: "run_terminal_command" }, env);
	ok(denied.decision === "deny", "hook receives a deny decision before execution");
	ok(seen.length === 2 && seen[0].toolName === "search_replace", "bridge forwards the exact PreToolUse payload");
	const forbidden = await post(env[APPROVAL_URL_ENV], "wrong-token", { toolName: "search_replace" });
	ok(forbidden.status === 403 && forbidden.body.decision === "deny", "invalid bearer token is denied");
	bridge.close();

	const failing = new GrokApprovalBridge({ authorize: async () => { throw new Error("boom"); } });
	const failingEnv = await failing.start();
	const failedClosed = await requestGrokApproval({ toolName: "run_terminal_command" }, failingEnv);
	ok(failedClosed.decision === "deny", "controller errors fail closed");
	failing.close();

	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	const grok = fs.readFileSync(path.join(__dirname, "grok.js"), "utf8");
	const panel = fs.readFileSync(path.join(__dirname, "media", "panel.js"), "utf8");
	ok(grok.includes("await this._ensureApprovalBridge()"), "Grok starts the bridge before spawning");
	ok(grok.indexOf("await this._ensureApprovalBridge()") < grok.indexOf("const args ="), "hook is active before CLI arguments are launched");
	ok(extension.includes("authorizeTool: (input) => this.authorizeGrokTool(input)"), "Grok authorization reaches the existing controller policy");
	ok(extension.includes("const result = await this.handleServerRequest(descriptor.method, descriptor.params)"), "Grok reuses Felix cards and credit gate");
	ok(panel.includes("params.oneShotOnly"), "sidebar hides the unsupported session-wide Grok grant");

	fs.rmSync(root, { recursive: true, force: true });
	console.log(`grokApprovalBridge.test.js: ${checks}/${checks} checks passed`);
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
