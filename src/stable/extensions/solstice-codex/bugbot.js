"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { GrokProvider } = require("./grok");

function reviewSnapshot(root, limit = 48000) {
	const diff = spawnSync("git", ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", "."], { cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
	let text = String(diff.stdout || "");
	const listed = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", timeout: 10000 });
	for (const rel of String(listed.stdout || "").split(/\r?\n/).filter(Boolean)) {
		if (text.length >= limit || /(?:lock|\.png|\.jpe?g|\.gif|\.zip|\.pdf)$/i.test(rel)) break;
		try { const body = fs.readFileSync(path.join(root, rel), "utf8"); text += `\n\n--- /dev/null\n+++ b/${rel}\n${body.slice(0, 10000)}`; } catch { }
	}
	return text.slice(0, limit);
}

function parseFindings(text) {
	const match = String(text || "").match(/\{[\s\S]*\}/);
	if (!match) return [];
	let parsed;
	try { parsed = JSON.parse(match[0]); } catch { return []; }
	return (Array.isArray(parsed.findings) ? parsed.findings : []).filter((item) => item && item.file && item.message)
		.slice(0, 5).map((item) => ({ severity: /^(critical|high|medium|low)$/i.test(item.severity) ? item.severity.toLowerCase() : "medium", file: String(item.file).slice(0, 240), line: Math.max(1, Number(item.line) || 1), message: String(item.message).replace(/\s+/g, " ").slice(0, 600) }));
}

async function runBugbot(root, options) {
	const snapshot = reviewSnapshot(root);
	if (!snapshot.trim()) return { findings: [], text: "", skipped: "empty diff" };
	let output = "", error = "";
	const provider = new GrokProvider({ cwd: root, bin: options.bin, extensionPath: options.extensionPath, log: options.log, notify(method, params) {
		if (method === "item/agentMessage/delta") output += params.delta || "";
		if (method === "error") error = params && params.error && params.error.message || "bugbot provider error";
	} });
	const prompt = `Review this git diff for real correctness, security, race, state, error-handling and cross-platform bugs. Do not suggest style changes. Do not use tools or edit files. Return ONLY JSON: {"findings":[{"severity":"critical|high|medium|low","file":"path","line":1,"message":"specific reproducible bug and fix direction"}]}. Return an empty findings array when there is no concrete bug. Maximum 5 findings.\n\nDIFF:\n${snapshot}`;
	await provider.send("composer-2.5", prompt, "You are Solstice Bugbot, a terse read-only code reviewer. Output strict JSON only.");
	if (error && !output.trim()) throw new Error(error);
	return { findings: parseFindings(output), text: output };
}

module.exports = { parseFindings, reviewSnapshot, runBugbot };
