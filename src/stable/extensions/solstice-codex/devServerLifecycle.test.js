"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { DevServer, readDevServerRegistration } = require("./preview");
const { listOwnedDevServers, stopAllOwnedDevServers } = require("./devServerTools");

let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }

function alive(pid) {
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

async function waitFor(predicate, timeoutMs = 6000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

function get(url) {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, body }));
		}).on("error", reject);
	});
}

function fixture(base, name) {
	const root = path.join(base, name);
	fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
		name,
		private: true,
		scripts: { dev: "node server.js" },
	}, null, 2));
	fs.writeFileSync(path.join(root, "server.js"), `
const http = require("http");
const name = ${JSON.stringify(name)};
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(name);
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
	return root;
}

(async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-f5-lifecycle-"));
	const roots = [fixture(base, "window-a"), fixture(base, "window-b"), fixture(base, "window-c")];
	const servers = roots.map((root) => new DevServer(root, { idleTimeoutMs: 60 * 1000 }));
	let idleServer = null;
	let evidence = null;
	try {
		const urls = await Promise.all(servers.map((server) => server.ensure()));
		ok(urls.every(Boolean), "three window-owned dev servers become reachable");
		ok(new Set(urls).size === 3, "three windows receive three isolated preview URLs");
		const registrations = roots.map((root) => readDevServerRegistration(root));
		ok(registrations.every((record) => record && record.pid && record.port), "each workspace records PID and port ownership");
		ok(new Set(registrations.map((record) => record.pid)).size === 3, "each window owns a distinct process");
		ok(new Set(registrations.map((record) => record.port)).size === 3, "each window owns a distinct port");

		const bodies = await Promise.all(urls.map(get));
		ok(bodies.every((response) => response.status === 200), "all three live previews return HTTP 200");
		ok(bodies.map((response) => response.body).join(",") === "window-a,window-b,window-c", "each window renders only its own project");

		const inventory = listOwnedDevServers(servers[0], new Map([["b", servers[1]], ["c", servers[2]]]));
		evidence = { createdAt: new Date().toISOString(), windows: inventory.map((entry) => ({ ...entry })) };
		ok(inventory.length === 3, "IDE inventory lists all three owned servers");
		ok(inventory.every((entry) => entry.pid && entry.port && entry.root && entry.idleDeadlineAt), "inventory exposes PID, port, project, and idle deadline");
		const pids = inventory.map((entry) => entry.pid);
		const closed = stopAllOwnedDevServers(servers[0], new Map([["b", servers[1]], ["c", servers[2]]]), "three-window-close");
		ok(closed.ok && closed.stopped === 3, "closing three windows stops all three owned server trees");
		ok(await waitFor(() => pids.every((pid) => !alive(pid))), "zero owned preview processes remain after window closure");
		ok(roots.every((root) => readDevServerRegistration(root) === null), "all workspace ownership records are cleared");
		evidence.afterClose = roots.map((root, index) => ({ root, pid: pids[index], alive: alive(pids[index]), registration: readDevServerRegistration(root) }));

		const idleRoot = fixture(base, "idle-window");
		idleServer = new DevServer(idleRoot, { idleTimeoutMs: 2200 });
		await idleServer.ensure();
		const idlePid = idleServer.proc.pid;
		ok(alive(idlePid), "idle acceptance server starts as an owned live process");
		ok(await waitFor(() => !alive(idlePid), 5000), "idle timeout automatically stops the owned process tree");
		ok(readDevServerRegistration(idleRoot) === null, "idle cleanup removes the workspace registry");

		const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
		const manager = fs.readFileSync(path.join(__dirname, "media", "manager.js"), "utf8");
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
		ok(/stopAllDevServers\("window-dispose"\)/.test(extension), "IDE window disposal is wired to close-all");
		ok(/stopAllDevServers\("project-closed"\)/.test(extension), "project closure is wired to close-all");
		ok(/manager-close-all/.test(extension) && /closeAllServersBtn/.test(manager), "Manager View exposes close-all to Thomas");
		ok(/mergeManagerTask[\s\S]*stopDevServerForAgent\(`manager:\$\{taskId\}`\)/.test(extension) && /newThread\(\)[\s\S]{0,120}stopDevServerForAgent\("workspace"\)/.test(extension), "build-session completion closes its owned server");
		ok(pkg.contributes.commands.some((command) => command.command === "solstice.agent.closeAllDevServers"), "command palette exposes Close All Preview Servers");
		ok(pkg.contributes.configuration.properties["solstice.codex.devServerIdleMinutes"].default === 30, "idle cleanup has a visible 30-minute default");
		if (process.env.SOLSTICE_F5_EVIDENCE_DIR) {
			const evidenceDir = path.resolve(process.env.SOLSTICE_F5_EVIDENCE_DIR);
			fs.mkdirSync(evidenceDir, { recursive: true });
			fs.writeFileSync(path.join(evidenceDir, "three-window-lifecycle.json"), JSON.stringify(evidence, null, 2) + "\n");
		}

		console.log(`devServerLifecycle.test.js: ${checks}/${checks} checks passed`);
	} finally {
		for (const server of servers) server.dispose();
		if (idleServer) idleServer.dispose();
		await new Promise((resolve) => setTimeout(resolve, 100));
		fs.rmSync(base, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
