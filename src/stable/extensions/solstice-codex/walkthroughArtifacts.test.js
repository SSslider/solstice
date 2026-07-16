"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const base = __dirname;
const browse = path.join(base, "webtools", "browse.js");
const walkthrough = path.join(base, "webtools", "walkthrough.js");
let passed = 0;
function ok(value, label) { assert.ok(value, label); passed++; console.log("ok - " + label); }

function run(file, args, timeout = 240000) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${path.basename(file)}`)); }, timeout);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(`${path.basename(file)} exited ${code}: ${stderr || stdout}`));
			resolve(stdout);
		});
	});
}

(async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-walkthrough-e2e-"));
	const taskId = "task-e2e-42";
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self' 'unsafe-inline'" });
		res.end(`<!doctype html><html><head><title>Artifact fixture</title><meta name="description" content="Artifact E2E"><meta name="viewport" content="width=device-width"></head><body style="margin:0;font-family:system-ui;background:#101521;color:white"><nav><a href="#proof">Proof</a></nav><main style="min-height:1800px;padding:40px"><h1>Real browser evidence</h1><button id="menu">Toggle details</button><p id="state">closed</p><section id="proof" style="margin-top:1100px"><h2>Delivery proof</h2></section></main><script>document.querySelector('#menu').onclick=()=>document.querySelector('#state').textContent='open'</script></body></html>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	try {
		const round = path.join(root, ".solstice", "self-check", taskId, "round-1");
		fs.mkdirSync(round, { recursive: true });
		const report = JSON.parse(await run(browse, ["check", url, round], 120000));
		ok(report.ok === true, "real-browser gate is green before packaging");
		const replicaDir = path.join(round, "replica-comparison");
		fs.mkdirSync(replicaDir, { recursive: true });
		for (const name of ["source-desktop.png", "source-tablet.png", "source-mobile.png", "desktop.png", "tablet.png", "mobile.png", "desktop-diff.png", "tablet-diff.png", "mobile-diff.png"]) fs.copyFileSync(path.join(round, "desktop.png"), path.join(replicaDir, name));
		fs.writeFileSync(path.join(replicaDir, "visual-diff.json"), JSON.stringify({ ok: true, score: 96.2, targetScore: 80 }, null, 2));
		fs.writeFileSync(path.join(replicaDir, "source-manifest.json"), JSON.stringify({ authorization: { confirmed: true } }, null, 2));
		fs.writeFileSync(path.join(replicaDir, "SOURCE_DECONSTRUCT.md"), "# Authorized source evidence\n");
		fs.writeFileSync(path.join(replicaDir, "VISUAL_DIFF.md"), "# Replica visual comparison\n");
		const replica = { ok: true, score: 96.2, targetScore: 80, sourceUrl: "https://client-owned.example/", evidenceDir: path.relative(root, replicaDir).split(path.sep).join("/") };
		fs.writeFileSync(path.join(round, "report.json"), JSON.stringify({ ...report, buildId: taskId, round: 1, replica }, null, 2) + "\n");
		const result = JSON.parse(await run(walkthrough, [root, url, "", taskId]));
		ok(result.ok === true && result.manifest.taskId === taskId, "walkthrough manifest is bound to taskId");
		ok(result.manifest.selfCheck.round === 1, "manifest records the green gate round");
		ok(result.manifest.gateDesktopScreenshot === "gate-desktop.png", "desktop screenshot comes from gate evidence");
		ok(fs.statSync(path.join(result.artifact, "walkthrough.mp4")).size > 4096, "real-browser MP4 recording is non-empty");
		ok(result.manifest.desktopScrollshots.length === 5, "five real scroll-depth screenshots are packaged");
		ok(Object.keys(result.manifest.evidence).includes("walkthrough.mp4"), "recording is covered by the evidence manifest");
		ok(result.manifest.replica.score === 96.2, "walkthrough manifest preserves replica visual score");
		ok(fs.existsSync(path.join(result.artifact, "replica-comparison", "mobile-diff.png")), "walkthrough packages source, replica and diff evidence");
		ok(fs.existsSync(path.join(result.artifact, "replica-comparison", "source-manifest.json")), "walkthrough retains source authorization and deconstruction provenance");
		ok(fs.readFileSync(path.join(result.artifact, "WALKTHROUGH.md"), "utf8").includes("## ככה בודקים"), "package includes a concrete how-to-test guide");
		const index = JSON.parse(fs.readFileSync(path.join(root, ".solstice", "artifacts", "index.json"), "utf8"));
		ok(index.artifacts[0].taskId === taskId, "project artifact index preserves task ownership");
		ok(index.artifacts[0].recording === "walkthrough.mp4", "IDE registry points to the real recording");
		console.log(`walkthroughArtifacts.test.js: ${passed}/${passed} checks passed`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		if (!process.env.SOLSTICE_KEEP_WALKTHROUGH_EVIDENCE) fs.rmSync(root, { recursive: true, force: true });
		else console.log("evidence: " + root);
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
