"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");
const { spawnSync } = require("child_process");
const { spawnBrowser, waitForDevTools } = require("./webtools/browserLaunch");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-launch-test-"));
let passed = 0;
async function run(name, source, check) {
	const profile = fs.mkdtempSync(path.join(root, "profile-"));
	const child = spawnBrowser(process.execPath, ["-e", source, profile]);
	try { await check(child, profile); console.log("PASS", name); passed++; }
	finally { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; } }
}
(async () => {
	await run("early exit preserves actionable stderr and exit code", 'process.stderr.write("Browser sandbox permission denied\\n"); process.exitCode=42;', async (child, profile) => {
		const started = Date.now();
		await assert.rejects(waitForDevTools(child, profile), (e) => /exit 42/.test(e.message) && /Browser sandbox permission denied/.test(e.message) && /SOLSTICE_BROWSER/.test(e.message));
		assert.ok(Date.now() - started < 3000, "dead browser must not consume the ten-second timeout");
	});
	await run("zero exit without a port is failure", 'process.exit(0)', async (child, profile) => {
		await assert.rejects(waitForDevTools(child, profile), /exit 0/);
	});
	await run("signal exit remains distinguishable", 'process.kill(process.pid,"SIGTERM")', async (child, profile) => {
		await assert.rejects(waitForDevTools(child, profile), /signal SIGTERM/);
	});
	await run("stderr stays bounded and strips terminal controls", 'process.stderr.write("x".repeat(100000)+"\\x1b[31mFINAL_DIAGNOSTIC\\x1b[0m\\x07"); process.exitCode=9;', async (child, profile) => {
		await assert.rejects(waitForDevTools(child, profile), (e) => e.message.length < 5000 && /FINAL_DIAGNOSTIC/.test(e.message) && !/[\x1b\x07]/.test(e.message));
	});
	await run("valid delayed port is returned", 'setTimeout(()=>require("fs").writeFileSync(require("path").join(process.argv[1],"DevToolsActivePort"),"43210\\n/devtools/browser/test"),80); setInterval(()=>{},1000)', async (child, profile) => {
		assert.equal(await waitForDevTools(child, profile), 43210);
	});
	await run("invalid ports do not pass readiness", 'setInterval(()=>{},1000)', async (child, profile) => {
		for (const value of ["65536", "123abc", "0", "-1"]) {
			fs.writeFileSync(path.join(profile, "DevToolsActivePort"), value);
			await assert.rejects(waitForDevTools(child, profile, 100), /DevTools port not available after 100ms/);
		}
	});
	const missing = spawnBrowser(path.join(root, "does-not-exist"), []);
	await assert.rejects(waitForDevTools(missing, root), /ENOENT/);
	console.log("PASS missing executable becomes an ordinary failure"); passed++;
	const pidFile = path.join(root, "kept-browser.pid");
	try {
		const wrapper = `const fs=require("fs");const {spawnBrowser,detachBrowser}=require(process.argv[1]);const child=spawnBrowser(process.execPath,["-e","setInterval(()=>{},1000)"]);fs.writeFileSync(process.argv[2],String(child.pid));detachBrowser(child);`;
		const result = spawnSync(process.execPath, ["-e", wrapper, path.join(__dirname,"webtools/browserLaunch.js"), pidFile], {timeout:3000,encoding:"utf8"});
		assert.equal(result.status, 0, "keep-open CLI must exit despite the diagnostic pipe");
		process.kill(Number(fs.readFileSync(pidFile,"utf8")), 0);
		console.log("PASS keep-open detaches both process and diagnostic pipe"); passed++;
	} finally {
		if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile,"utf8"))); } catch {} }
	}
	console.log(`browserLaunch.test.js: ${passed}/${passed} checks passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive:true, force:true}));
