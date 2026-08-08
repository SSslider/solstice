#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function fail(message) {
	console.error(`PACKAGED_SCROLLWORLD_FAIL: ${message}`);
	process.exit(1);
}

const extensionDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) fail("pass the packaged solstice-codex extension directory");

const expected = [
	"package.json",
	path.join("prompts", "scroll-world", "SKILL.md"),
	path.join("prompts", "scroll-world", "references", "pipeline.md"),
	path.join("prompts", "scroll-world", "references", "scrub-engine.js"),
];

for (const relative of expected) {
	const file = path.join(extensionDir, relative);
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
		fail(`required bundle asset is missing: ${file}`);
	}
}

let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8")); }
catch (error) { fail(`package.json is unreadable: ${error.message}`); }
if (manifest.name !== "solstice-codex") fail(`unexpected extension manifest: ${manifest.name || "<missing name>"}`);

const skillFile = path.join(extensionDir, "prompts", "scroll-world", "SKILL.md");
const skill = fs.readFileSync(skillFile, "utf8");
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
const declaredName = frontmatter && frontmatter[1].split("\n")
	.map((line) => line.match(/^name:\s*(.+?)\s*$/))
	.find(Boolean);
if (!declaredName || declaredName[1] !== "scroll-world-gpt-image") {
	fail(`SKILL.md has invalid or unexpected frontmatter: ${skillFile}`);
}
if (Buffer.byteLength(skill.trim()) < 1000) fail(`SKILL.md is unexpectedly truncated: ${skillFile}`);

console.log(JSON.stringify({
	ok: true,
	extensionDir,
	skillFile,
	skillBytes: Buffer.byteLength(skill),
	resources: expected.slice(2).map((relative) => ({
		path: relative.replace(/\\/g, "/"),
		bytes: fs.statSync(path.join(extensionDir, relative)).size,
	})),
}, null, 2));
