#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { dueScheduledChecks, checksFile } = require("../projectBrain");

function fail(message) { console.error("site-check: " + message); process.exit(1); }
function sha(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function slug(value) { return String(value || "site").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(); }
function runBrowse(args) {
	const result = spawnSync(process.execPath, [path.join(__dirname, "browse.js"), ...args], { encoding: "utf8", timeout: 240000 });
	if (result.error || result.status !== 0) throw new Error((result.error && result.error.message) || result.stderr || `browse exited ${result.status}`);
}
async function liveStatus(url) {
	const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
	try { const res = await fetch(url, { redirect: "follow", signal: controller.signal }); return { ok: res.ok, status: res.status, finalUrl: res.url }; }
	catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
	finally { clearTimeout(timer); }
}

async function main() {
	const root = path.resolve(process.argv[2] || ""); if (!root || !fs.existsSync(root)) fail("usage: site-check.js <workspace> [--dry-run]");
	const due = dueScheduledChecks(root);
	if (process.argv.includes("--dry-run")) { console.log(JSON.stringify({ ok: true, due }, null, 2)); return; }
	const configFile = checksFile(root); const cfg = JSON.parse(fs.readFileSync(configFile, "utf8")); const results = [];
	for (const site of due) {
		const checkedAt = new Date().toISOString(); const base = path.join(root, ".solstice", "scheduled-checks", slug(site.id)); const stamp = checkedAt.replace(/[:.]/g, "-"); const out = path.join(base, stamp); fs.mkdirSync(out, { recursive: true });
		const live = await liveStatus(site.url); let visual = { files: [], hashes: {}, changed: null };
		if (live.ok) {
			const prefix = path.join(out, "scroll"); runBrowse(["scrollshot", site.url, prefix, "3"]);
			const files = fs.readdirSync(out).filter((x) => /^scroll_s\d+\.png$/.test(x)).sort(); const hashes = Object.fromEntries(files.map((f) => [f, sha(path.join(out, f))]));
			let previous = {}; try { previous = JSON.parse(fs.readFileSync(path.join(base, "latest.json"), "utf8")); } catch { }
			visual = { files, hashes, changed: previous.visual ? JSON.stringify(previous.visual.hashes || {}) !== JSON.stringify(hashes) : null };
		}
		const result = { id: site.id, url: site.url, checkedAt, live, visual, deviation: !live.ok || visual.changed === true };
		fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
		fs.writeFileSync(path.join(out, "REPORT.md"), ["# Scheduled site check", "", `- Checked: ${checkedAt}`, `- URL: ${site.url}`, `- Live: ${live.ok ? "yes" : "no"} (${live.status})`, `- Visual deviation: ${visual.changed === null ? "baseline created" : visual.changed ? "detected" : "none"}`, `- Overall deviation: ${result.deviation ? "YES" : "no"}`, "", ...visual.files.map((f) => `![${f}](./${f})`), ""].join("\n"));
		fs.writeFileSync(path.join(base, "latest.json"), JSON.stringify(result, null, 2) + "\n"); results.push(result);
		const target = cfg.sites.find((x) => x.id === site.id); if (target) { target.lastRunAt = checkedAt; target.lastResult = { ok: live.ok, status: live.status, deviation: result.deviation, report: path.join(out, "REPORT.md") }; }
	}
	fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n"); console.log(JSON.stringify({ ok: true, checked: results.length, results }, null, 2));
}
main().catch((e) => fail(e && e.stack || e));
