#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function fail(message) { console.error("walkthrough: " + message); process.exit(1); }
function run(args) {
	const browse = path.join(__dirname, "browse.js");
	const result = spawnSync(process.execPath, [browse, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
	if (result.error || result.status !== 0) fail((result.error && result.error.message) || result.stderr || `browse exited ${result.status}`);
	return String(result.stdout || "").trim();
}
function files(dir, re) { try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort(); } catch { return []; } }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

const [rootArg, previewUrl, liveUrlArg] = process.argv.slice(2);
if (!rootArg || !previewUrl) fail("usage: walkthrough.js <workspace> <preview-url> [live-url]");
const root = path.resolve(rootArg);
try { if (!fs.statSync(root).isDirectory()) fail("workspace is not a directory"); } catch { fail("workspace does not exist"); }
try { new URL(previewUrl); } catch { fail("invalid preview URL"); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.join(root, ".solstice", "walkthrough", stamp);
fs.mkdirSync(out, { recursive: true });
const desktopPrefix = path.join(out, "desktop");
const mobile = path.join(out, "mobile.png");
run(["scrollshot", previewUrl, desktopPrefix, "5"]);
run(["shot", previewUrl, mobile, "390x844"]);
const desktop = files(out, /^desktop_s\d+\.png$/);
if (desktop.length !== 5) fail(`expected 5 desktop scrollshots, found ${desktop.length}`);
if (!fs.existsSync(mobile) || fs.statSync(mobile).size === 0) fail("mobile screenshot was not created");
const fidelityFile = path.join(root, ".solstice", "FIDELITY.md");
let fidelity = "No FIDELITY.md was present for this build.";
try { fidelity = fs.readFileSync(fidelityFile, "utf8").slice(0, 12000); } catch { }
let deploy = {};
try { deploy = JSON.parse(fs.readFileSync(path.join(root, ".solstice", "deploy.json"), "utf8")); } catch { }
const liveUrl = liveUrlArg || deploy.liveUrl || "";
const evidenceFiles = [...desktop, "mobile.png"];
const evidence = Object.fromEntries(evidenceFiles.map((file) => [file, { bytes: fs.statSync(path.join(out, file)).size, sha256: sha256(path.join(out, file)) }]));
const manifest = {
	createdAt: new Date().toISOString(),
	previewUrl,
	liveUrl: liveUrl || null,
	desktopScrollshots: desktop,
	mobileScreenshot: "mobile.png",
	fidelityFile: fs.existsSync(fidelityFile) ? ".solstice/FIDELITY.md" : null,
	evidence,
};
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(out, "SHA256SUMS"), evidenceFiles.map((file) => `${evidence[file].sha256}  ${file}`).join("\n") + "\n");
const md = [
	"# Solstice Build Walkthrough", "", `Generated: ${manifest.createdAt}`, "",
	"## Links", "", `- Preview: ${previewUrl}`, `- Live production: ${liveUrl || "not deployed"}`, "",
	"## Visual evidence", "", ...desktop.map((f, i) => `- [Desktop scroll depth ${i * 25}%](./${f})`), "- [Mobile viewport 390×844](./mobile.png)", "",
	"## Fidelity", "", fidelity.trim(), "",
	"## Integrity", "", `- ${evidenceFiles.length} visual files captured`, "- SHA-256 checksums: `SHA256SUMS`", "- Machine-readable manifest: `manifest.json`", "",
].join("\n");
fs.writeFileSync(path.join(out, "WALKTHROUGH.md"), md);
console.log(JSON.stringify({ ok: true, artifact: out, manifest }, null, 2));
