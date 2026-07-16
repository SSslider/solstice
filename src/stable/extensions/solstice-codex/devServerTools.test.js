"use strict";

const assert = require("assert");
const { execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { promisify } = require("util");
const {
	DevServerToolBridge,
	agentToolCommand,
	isSafeDevServerToolApproval,
	listOwnedDevServers,
	requestTool,
	stopAllOwnedDevServers,
	stopOwnedDevServer,
} = require("./devServerTools");

let passed = 0;
function ok(value, name) { assert.ok(value, name); passed++; console.log("ok - " + name); }

function fakeServer(root, pid, port, owned = true) {
	return {
		root,
		proc: owned ? { pid, exitCode: null } : null,
		port,
		url: `http://127.0.0.1:${port}`,
		stopCalls: 0,
		hasOwnedProcess() { return !!this.proc; },
		stop() {
			this.stopCalls++;
			const stoppedPid = this.proc && this.proc.pid;
			this.proc = null;
			return { stopped: !!stoppedPid, pid: stoppedPid || null };
		},
	};
}

function rawPost(url, token) {
	return new Promise((resolve, reject) => {
		const body = "{}";
		const req = http.request(new URL("/solstice/dev-server-list", url), {
			method: "POST",
			headers: { "content-length": Buffer.byteLength(body), "x-solstice-tool-token": token },
		}, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode));
		});
		req.on("error", reject);
		req.end(body);
	});
}

async function main() {
	const workspace = fakeServer("/projects/site-a", 101, 12001);
	const manager = fakeServer("/projects/site-b", 202, 12002);
	const idle = fakeServer("/projects/site-c", 303, 12003, false);
	const managers = new Map([["task-b", manager], ["idle", idle]]);
	const listed = listOwnedDevServers(workspace, managers);
	ok(listed.length === 2, "list returns only IDE-owned live servers");
	ok(listed[0].id === "workspace" && listed[1].id === "manager:task-b", "list exposes stable workspace and manager ids");
	ok(listed.every((item) => item.ownedBySolstice && item.pid && item.root), "list returns ownership evidence");

	const unknown = stopOwnedDevServer(workspace, managers, "manager:missing");
	ok(!unknown.ok && unknown.error === "owned_server_not_running", "unknown manager server is not stopped");
	ok(workspace.stopCalls === 0 && manager.stopCalls === 0, "unknown id cannot touch a running server");
	const invalid = stopOwnedDevServer(workspace, managers, "workspace;kill-all");
	ok(!invalid.ok && invalid.error === "invalid_server_id", "unsafe server id is rejected");
	const stoppedManager = stopOwnedDevServer(workspace, managers, "manager:task-b");
	ok(stoppedManager.ok && stoppedManager.pid === 202 && manager.stopCalls === 1, "manager stop maps to the owned DevServer.stop method");
	const stoppedWorkspace = stopOwnedDevServer(workspace, managers, "workspace");
	ok(stoppedWorkspace.ok && stoppedWorkspace.pid === 101 && workspace.stopCalls === 1, "workspace stop maps to the owned DevServer.stop method");
	const closeWorkspace = fakeServer("/projects/close-a", 301, 12005);
	const closeManager = fakeServer("/projects/close-b", 302, 12006);
	const closed = stopAllOwnedDevServers(closeWorkspace, new Map([["close-b", closeManager]]));
	ok(closed.ok && closed.stopped === 2 && closed.requested === 2, "close-all stops every live server owned by the window");
	ok(closeWorkspace.stopCalls === 1 && closeManager.stopCalls === 1, "close-all cannot escape the in-memory ownership registry");

	const bridgeWorkspace = fakeServer("/projects/live", 404, 12004);
	const bridgeManager = fakeServer("/projects/live-manager", 405, 12007);
	const bridgeManagers = new Map([["live-manager", bridgeManager]]);
	const bridge = new DevServerToolBridge({
		list: () => listOwnedDevServers(bridgeWorkspace, bridgeManagers),
		stop: (id) => stopOwnedDevServer(bridgeWorkspace, bridgeManagers, id),
		stopAll: () => stopAllOwnedDevServers(bridgeWorkspace, bridgeManagers),
	});
	const env = await bridge.start();
	try {
		const listResult = await requestTool("dev-server-list", {}, env);
		ok(listResult.ok && listResult.servers.length === 2 && listResult.servers[0].pid === 404, "loopback solstice/dev-server-list returns the live owned servers");
		const cli = await promisify(execFile)(process.execPath, [path.join(__dirname, "devServerTools.js"), "list"], { env: { ...process.env, ...env } });
		const cliResult = JSON.parse(cli.stdout);
		ok(cliResult.ok && cliResult.servers[0].pid === 404, "packaged helper CLI reaches the in-process bridge");
		ok(await rawPost(env.SOLSTICE_DEV_SERVER_TOOL_URL, "wrong-token") === 403, "loopback bridge rejects an invalid token");
		const stopResult = await requestTool("dev-server-stop", { id: "manager:live-manager" }, env);
		ok(stopResult.ok && stopResult.pid === 405 && bridgeManager.stopCalls === 1, "loopback solstice/dev-server-stop calls the IDE handler");
		await assert.rejects(() => requestTool("dev-server-stop", { id: "manager:live-manager" }, env), /owned_server_not_running/);
		passed++; console.log("ok - repeated stop fails closed");
		const closeAllResult = await requestTool("dev-server-stop-all", {}, env);
		ok(closeAllResult.ok && closeAllResult.stopped === 1 && bridgeWorkspace.stopCalls === 1, "loopback solstice/dev-server-stop-all closes the remaining window server");
	} finally { bridge.close(); }

	const executable = "/opt/Solstice/Electron";
	const script = "/opt/Solstice/devServerTools.js";
	const listCommand = agentToolCommand(executable, script, "list", null, "linux");
	const stopCommand = agentToolCommand(executable, script, "stop", "manager:task-b", "linux");
	const closeAllCommand = agentToolCommand(executable, script, "close-all", null, "linux");
	ok(isSafeDevServerToolApproval({ command: listCommand }, executable, script, "linux"), "exact list command bypasses the approval card");
	ok(isSafeDevServerToolApproval({ command: stopCommand }, executable, script, "linux"), "exact owned stop command bypasses the approval card");
	ok(isSafeDevServerToolApproval({ command: closeAllCommand }, executable, script, "linux"), "exact close-all command bypasses the approval card");
	ok(!isSafeDevServerToolApproval({ command: stopCommand + "; rm -rf /" }, executable, script, "linux"), "chained shell text never bypasses approval");
	ok(!isSafeDevServerToolApproval({ command: "kill -9 202" }, executable, script, "linux"), "raw PID kill never bypasses approval");
	const winCommand = agentToolCommand("C:\\Solstice\\Solstice.exe", "C:\\Solstice\\devServerTools.js", "stop", "workspace", "win32");
	ok(isSafeDevServerToolApproval({ command: winCommand }, "C:\\Solstice\\Solstice.exe", "C:\\Solstice\\devServerTools.js", "win32"), "exact Windows helper command bypasses approval");

	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	const codex = fs.readFileSync(path.join(__dirname, "codexClient.js"), "utf8");
	const grok = fs.readFileSync(path.join(__dirname, "grok.js"), "utf8");
	const claude = fs.readFileSync(path.join(__dirname, "claude.js"), "utf8");
	ok((extension.match(/this\.devServerToolInstructions\(\)/g) || []).length === 3, "tool contract is injected into Codex, Grok and Claude prompts");
	ok(/env: devServerToolEnv/.test(extension) && /this\.opts\.env/.test(codex) && /this\.env/.test(grok) && /this\.env/.test(claude), "tokenized bridge environment reaches all three engines");
	ok(/allowedTools: this\.claudeDevServerAllowedTools\(\)/.test(extension) && /--allowedTools/.test(claude), "Claude receives exact no-prompt Bash grants for the IDE-owned tools");
	ok(/stopOwnedDevServer\(this\.devServer, this\.managerDevServers, id/.test(extension), "extension maps the tool to workspace and manager DevServer registries");
	ok(/stopAllDevServers\("window-dispose"\)/.test(extension) && /onDidChangeWorkspaceFolders/.test(extension), "window and project closure trigger owned-server cleanup");
	ok(/devServersCard/.test(fs.readFileSync(path.join(__dirname, "media", "manager.js"), "utf8")), "Manager View renders the running-server inventory");

	console.log(`${passed}/${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
