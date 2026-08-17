"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { DevServer, resolveFrameworkSpawn } = require("./preview");

let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }

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

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-clean-exit-"));
	const viteDir = path.join(root, "node_modules", "vite");
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(path.join(viteDir, "bin"), { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
		name: "clean-exit-repro",
		private: true,
		scripts: { dev: "vite" },
		devDependencies: { vite: "test" },
	}, null, 2));
	fs.writeFileSync(path.join(viteDir, "package.json"), JSON.stringify({
		name: "vite",
		bin: { vite: "bin/vite.js" },
	}, null, 2));
	fs.writeFileSync(path.join(viteDir, "bin", "vite.js"), `
const http = require("http");
const args = process.argv.slice(2);
const at = args.indexOf("--port");
const port = Number(at >= 0 ? args[at + 1] : process.env.PORT);
const server = http.createServer((_req, res) => { res.writeHead(200); res.end("direct-vite-live"); });
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
	// This is the production failure from Thomas's screenshot: npm's local shim
	// exits successfully without keeping the framework server alive.
	const shim = path.join(binDir, "vite");
	fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(shim, 0o755);

	const spec = resolveFrameworkSpawn(root, "dev", 12345);
	ok(spec && spec.command === process.execPath, "plain Vite scripts resolve to the packaged Node runtime directly");
	ok(spec.args[0] === path.join(viteDir, "bin", "vite.js"), "the local package bin is used instead of npm's wrapper");
	ok(spec.args.includes("--port") && spec.args.includes("12345"), "the owned workspace port is passed to Vite");
	ok(spec.env && spec.env.ELECTRON_RUN_AS_NODE === "1", "the packaged Electron executable is explicitly switched to Node mode");

	const server = new DevServer(root, { idleTimeoutMs: 0 });
	try {
		const url = await server.ensure();
		ok(Boolean(url), "a clean-exiting npm shim no longer leaves preview without a URL");
		const response = await get(url);
		ok(response.status === 200 && response.body === "direct-vite-live", "the recovered URL serves the actual project over HTTP");
		ok(server.hasOwnedProcess(), "Solstice owns the real framework process for later cleanup");
	} finally {
		server.dispose();
		await new Promise((resolve) => setTimeout(resolve, 100));
		fs.rmSync(root, { recursive: true, force: true });
	}

	console.log(`devServerCleanExitRecovery.test.js: ${checks}/${checks} checks passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
