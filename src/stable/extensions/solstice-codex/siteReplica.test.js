"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { BREAKPOINTS, TARGET_SCORE, safeHttpUrl } = require("./webtools/site-replica");

const browse = path.join(__dirname, "webtools", "browse.js");
let passed = 0;
function ok(value, label) { assert.ok(value, label); passed++; console.log("ok - " + label); }

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [browse, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => { child.kill(); reject(new Error("replica browser test timed out")); }, 150000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(stderr || `browse exited ${code}`));
			try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`invalid replica JSON: ${error.message}\n${stdout}\n${stderr}`)); }
		});
	});
}

function page(drift) {
	if (drift) return `<!doctype html><html><head><title>Different</title><meta name=viewport content="width=device-width"><style>body{margin:0;background:#f9ecff;color:#24112d;font:18px serif}section{height:720px;display:grid;place-items:center;border-bottom:20px solid #ff2fc7}h1{font-size:70px}</style></head><body><section><h1>Unrelated layout</h1></section><section><p>Different colors and geometry</p></section></body></html>`;
	return `<!doctype html><html lang="he" dir="rtl"><head><title>Authorized client fixture</title><meta name=description content="Replica source fixture"><meta name=viewport content="width=device-width"><style>
		*{box-sizing:border-box}body{margin:0;background:#09111f;color:#f4efe6;font-family:Arial,sans-serif}.nav{height:76px;display:flex;align-items:center;justify-content:space-between;padding:0 7vw;background:#101d31}.hero{min-height:760px;padding:120px 8vw;background:linear-gradient(135deg,#102541,#6f4b28)}h1{font-size:clamp(48px,8vw,110px);max-width:900px;margin:0}.hero p{font-size:24px;max-width:650px}.grid{min-height:720px;padding:80px 8vw;background:#efe7d8;color:#132033;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.card{padding:32px;border:2px solid #132033;border-radius:24px}.footer{min-height:420px;padding:80px 8vw;background:#c87f3d;color:#151515}@media(max-width:600px){.nav{height:64px}.hero{min-height:680px;padding-top:90px}.grid{grid-template-columns:1fr;min-height:1100px}h1{font-size:54px}}
	</style></head><body><header class=nav><strong>לקוח</strong><a href="#work">עבודות</a></header><main><section class=hero><h1>מערכת עם אופי ברור</h1><p>תוכן אמיתי, היררכיה מדויקת ורספונסיביות.</p></section><section id=work class=grid><article class=card><h2>אסטרטגיה</h2><p>מבנה ותוכן.</p></article><article class=card><h2>עיצוב</h2><p>צבע וטיפוגרפיה.</p></article><article class=card><h2>ביצוע</h2><p>מובייל ודסקטופ.</p></article></section></main><footer class=footer><h2>מדברים</h2></footer></body></html>`;
}

(async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-replica-e2e-"));
	const sourceDir = path.join(tmp, "source"), passDir = path.join(tmp, "pass"), failDir = path.join(tmp, "fail");
	let drift = false;
	const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page(drift)); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	try {
		ok(BREAKPOINTS.map((point) => point.name).join(",") === "desktop,tablet,mobile", "source contract covers desktop, tablet and mobile");
		ok(TARGET_SCORE === 80, "visual gate target is 80 percent");
		ok(safeHttpUrl(url) === url, "authorized fixture URL is normalized");
		let blocked = false;
		try { await run(["replica-source", url, path.join(tmp, "blocked")]); } catch (error) { blocked = /--authorized/.test(error.message); }
		ok(blocked, "source capture fails closed without authorization confirmation");
		const source = await run(["replica-source", url, sourceDir, "--authorized"]);
		ok(source.authorization.confirmed === true, "source manifest records authorization boundary");
		ok(source.breakpoints.length === 3, "source capture writes all three breakpoints");
		ok(source.design.sections.length >= 3, "rendered structure is extracted without copying source code");
		ok(!Object.prototype.hasOwnProperty.call(source.design, "html"), "manifest contains no raw HTML source");
		for (const point of BREAKPOINTS) ok(fs.statSync(path.join(sourceDir, `${point.name}.png`)).size > 1000, `${point.name} source screenshot is real`);
		ok(fs.readFileSync(path.join(sourceDir, "DECONSTRUCT.md"), "utf8").includes("did not copy source code"), "deconstruction states the code-copy boundary");
		const same = await run(["replica-compare", sourceDir, url, passDir, "fixture-task"]);
		ok(same.ok === true && same.score >= TARGET_SCORE, "faithful rebuild passes the rendered visual gate");
		ok(same.taskId === "fixture-task", "visual evidence stays bound to taskId");
		ok(same.comparisons.every((item) => typeof item.source === "string" && typeof item.replica === "string"), "manifest links point to packaged source and replica images");
		ok(same.comparisons.every((item) => fs.statSync(path.join(passDir, item.heatmap)).size > 100), "each breakpoint produces a real diff heatmap");
		ok(!fs.readFileSync(path.join(passDir, "VISUAL_DIFF.md"), "utf8").includes("[object Object]"), "human comparison report contains valid image links");
		drift = true;
		const changed = await run(["replica-compare", sourceDir, url, failDir, "fixture-task"]);
		ok(changed.ok === false && changed.score < TARGET_SCORE, "materially different rebuild fails the visual gate");
		ok(fs.existsSync(path.join(failDir, "VISUAL_DIFF.md")), "comparison package includes a human-readable report");
		console.log(`siteReplica.test.js: ${passed}/${passed} checks passed`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		if (process.env.SOLSTICE_KEEP_REPLICA_EVIDENCE) console.log("evidence: " + tmp);
		else fs.rmSync(tmp, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
