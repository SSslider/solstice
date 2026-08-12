"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
	allocateWorkspacePort,
	clearDevServerRegistration,
	DevServer,
	detectDevServerUrl,
	readDevServerRegistration,
	writeDevServerRegistration,
} = require("./preview");

function listen(port, body) {
	return new Promise((resolve, reject) => {
		const server = http.createServer((_req, res) => {
			const accent = body === "SITE_A" ? "#7c3aed" : "#0891b2";
			const html = `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#09090b;color:white;font:700 42px system-ui"><main style="padding:64px;border:2px solid ${accent};border-radius:28px;background:linear-gradient(145deg,${accent}44,#18181b)">${body}<small style="display:block;margin-top:18px;font:500 18px system-ui;color:#d4d4d8">Workspace-owned preview · port ${port}</small></main></body></html>`;
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html);
		});
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

function capture(url, file) {
	return new Promise((resolve, reject) => {
		const child = spawn("chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=900,600", `--screenshot=${file}`, url], { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`chromium screenshot failed (${code})`)));
	});
}

function get(url) {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => resolve(body));
		}).on("error", reject);
	});
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

(async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-preview-isolation-"));
	const rootA = path.join(base, "site-a");
	const rootB = path.join(base, "site-b");
	fs.mkdirSync(rootA, { recursive: true });
	fs.mkdirSync(rootB, { recursive: true });
	let serverA = null, serverB = null;

	try {
		const portA = await allocateWorkspacePort(rootA);
		assert.ok(portA >= 12000 && portA < 14000, "workspace A receives a bounded dedicated port");
		serverA = await listen(portA, "SITE_A");

		const portB = await allocateWorkspacePort(rootB);
		assert.ok(portB >= 12000 && portB < 14000, "workspace B receives a bounded dedicated port");
		assert.notEqual(portB, portA, "a live workspace port is never reallocated");
		serverB = await listen(portB, "SITE_B");

		writeDevServerRegistration(rootA, { port: portA, pid: process.pid, ts: new Date().toISOString() });
		writeDevServerRegistration(rootB, { port: portB, pid: process.pid, ts: new Date().toISOString() });
		assert.equal(readDevServerRegistration(rootA).port, portA, "workspace A owns its registry");
		assert.equal(readDevServerRegistration(rootB).port, portB, "workspace B owns its registry");

		const urlA = await detectDevServerUrl(rootA, { ports: [portB, portA] });
		const urlB = await detectDevServerUrl(rootB, { ports: [portA, portB] });
		assert.equal(urlA, `http://127.0.0.1:${portA}/`);
		assert.equal(urlB, `http://127.0.0.1:${portB}/`);
		assert.notEqual(urlA, urlB, "two windows resolve different preview URLs");
		assert.match(await get(urlA), /SITE_A/, "window A renders project A");
		assert.match(await get(urlB), /SITE_B/, "window B renders project B");
		if (process.env.SOLSTICE_PREVIEW_EVIDENCE_DIR) {
			const out = path.resolve(process.env.SOLSTICE_PREVIEW_EVIDENCE_DIR);
			fs.mkdirSync(out, { recursive: true });
			await capture(urlA, path.join(out, "solstice-cp-s1-window-a.png"));
			await capture(urlB, path.join(out, "solstice-cp-s1-window-b.png"));
		}

		clearDevServerRegistration(rootA, process.pid);
		assert.equal(await detectDevServerUrl(rootA, { ports: [portB] }), null, "blind fallback cannot adopt another workspace");
		assert.match(await get(urlB), /SITE_B/, "rejecting a foreign preview does not disturb its server");

		const wrongRootFile = path.join(rootA, ".solstice", "dev-server.json");
		fs.mkdirSync(path.dirname(wrongRootFile), { recursive: true });
		fs.writeFileSync(wrongRootFile, JSON.stringify({ port: portB, pid: process.pid, root: rootB, ts: new Date().toISOString() }));
		assert.equal(readDevServerRegistration(rootA), null, "registry root mismatch is rejected");
		assert.equal(await detectDevServerUrl(rootA, { ports: [portB] }), null, "root mismatch cannot cross-wire previews");

		writeDevServerRegistration(rootA, { port: portA, pid: 2147483647, ts: "2020-01-01T00:00:00.000Z" });
		assert.equal(await detectDevServerUrl(rootA, { ports: [portA] }), null, "dead owner registrations are rejected");
		assert.equal(fs.existsSync(wrongRootFile), false, "dead owner registration is removed");

		writeDevServerRegistration(rootA, { port: portA + 1, pid: process.pid, ts: new Date().toISOString() });
		assert.equal(await detectDevServerUrl(rootA, { ports: [portA + 1] }), null, "a registered server may still be starting");
		assert.equal(fs.existsSync(wrongRootFile), true, "fresh startup ownership survives until the server listens");

		writeDevServerRegistration(rootA, { port: portA, pid: process.pid });
		assert.equal(clearDevServerRegistration(rootA, process.pid + 1), false, "a different process cannot clear ownership");
		assert.equal(readDevServerRegistration(rootA).pid, process.pid);
		assert.equal(clearDevServerRegistration(rootA, process.pid), true, "the owner can clear its registry");
		assert.equal(readDevServerRegistration(rootA), null);

		const owned = new DevServer(rootA, { idleTimeoutMs: 0 });
		owned.proc = { pid: process.pid, exitCode: null };
		owned.port = portA;
		owned.url = `http://127.0.0.1:${portA}/`;
		assert.equal(await owned.ensure(), owned.url, "the current window reuses its owned live server");
		assert.deepEqual(
			{ port: readDevServerRegistration(rootA)?.port, pid: readDevServerRegistration(rootA)?.pid },
			{ port: portA, pid: process.pid },
			"reusing an owned server heals a missing workspace registration",
		);
		clearDevServerRegistration(rootA, process.pid);

		const source = fs.readFileSync(path.join(__dirname, "preview.js"), "utf8");
		assert.match(source, /PORT: String\(port\)/, "spawn receives the allocated PORT");
		assert.match(source, /SOLSTICE_WORKSPACE_ROOT: canonicalRoot\(this\.root\)/, "spawn receives explicit workspace ownership");
		assert.match(source, /args\.push\("--", "--port", String\(port\)\)/, "framework CLI receives the same port");

		console.log("previewIsolation.test.js: 27/27 checks passed");
	} finally {
		if (serverA) await close(serverA);
		if (serverB) await close(serverB);
		fs.rmSync(base, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
