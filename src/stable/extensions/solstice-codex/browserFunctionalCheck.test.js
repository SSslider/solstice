"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const browse = path.join(__dirname, "webtools", "browse.js");
let passed = 0;
function ok(value, label) { assert.ok(value, label); passed++; console.log("ok - " + label); }

function runCheck(url, outDir) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [browse, "check", url, outDir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => { child.kill(); reject(new Error("browser check timed out")); }, 90000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(stderr || `browse check exited ${code}`));
			try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`invalid browser report: ${error.message}\n${stdout}\n${stderr}`)); }
		});
	});
}

function page(kind) {
	if (kind === "green") return `<!doctype html><html><head><title>Green fixture</title><meta name="viewport" content="width=device-width"></head><body>
		<a href="/about">About</a><button id="toggle">Open menu</button><p id="state">closed</p>
		<form><input required type="email" aria-label="Email"><button type="submit">Send</button></form>
		<script>document.querySelector('#toggle').onclick=()=>document.querySelector('#state').textContent='open';document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});document.querySelector('#state').textContent='sent';};</script>
	</body></html>`;
	return `<!doctype html><html><head><title>Broken fixture</title><meta name="viewport" content="width=device-width"></head><body style="margin:0">
		<a href="/missing">Missing page</a><button>Dead button</button><div style="width:900px;height:20px">overflow</div><img src="/broken.png" alt="broken">
		<script>console.error('fixture console explosion')</script>
	</body></html>`;
}

(async () => {
	const evidenceDir = String(process.env.SOLSTICE_BROWSER_EVIDENCE_DIR || "").trim();
	const tmp = evidenceDir ? path.resolve(evidenceDir) : fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browser-e2e-"));
	if (evidenceDir) fs.mkdirSync(tmp, { recursive: true });
	let mode = "green";
	let submitHits = 0;
	const server = http.createServer((req, res) => {
		if (req.url === "/submit") { submitHits++; res.writeHead(200, { "content-type": "application/json" }); res.end('{"saved":true}'); return; }
		if (req.url === "/about") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>About</title><meta name=viewport content='width=device-width'><a href='/'>Home</a><p>About works</p>"); return; }
		if (req.url === "/missing" || req.url === "/broken.png") { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
		res.writeHead(200, { "content-type": "text/html" }); res.end(page(mode));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	try {
		const green = await runCheck(url, path.join(tmp, "green"));
		ok(green.ok === true, "working site passes the real-browser gate");
		ok(green.summary.linksChecked >= 1, "navigation link is clicked");
		ok(green.summary.buttonsChecked >= 1, "interactive button is clicked");
		ok(green.summary.formsChecked === 1, "form validation and submit handler are exercised");
		ok(green.summary.mutationsIntercepted >= 1, "mutating form requests are intercepted inside the browser");
		ok(submitHits === 0, "functional QA never sends the intercepted POST to the fixture server");
		ok(fs.statSync(path.join(tmp, "green", "desktop.png")).size > 0, "desktop evidence screenshot is written");
		ok(fs.statSync(path.join(tmp, "green", "mobile.png")).size > 0, "mobile evidence screenshot is written");

		mode = "broken";
		const red = await runCheck(url, path.join(tmp, "broken"));
		ok(red.ok === false, "broken site fails the browser gate");
		const categories = new Set(red.findings.map((finding) => finding.check));
		ok(categories.has("404"), "HTTP 404 is reported");
		ok(categories.has("console"), "console error is reported");
		ok(categories.has("dead-control"), "dead button is reported");
		ok(categories.has("layout"), "mobile overflow is reported");
		ok(categories.has("resource"), "broken image is reported");
		if (evidenceDir) fs.writeFileSync(path.join(tmp, "results.json"), JSON.stringify({ green, red, submitHits }, null, 2) + "\n");
		console.log(`browserFunctionalCheck.test.js: ${passed}/${passed} checks passed`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		if (!evidenceDir) fs.rmSync(tmp, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
