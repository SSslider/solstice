"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");

const SKIP_DIRS = new Set([".git", ".solstice", "node_modules", "dist", "build", ".next", "coverage"]);
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|html?|css|scss|json|ya?ml|env|md|py|rb|php|go|rs)$/i;
const SECRET_PATTERNS = [
	["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
	["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
	["github-token", /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/],
	["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
	["stripe-live-key", /\b[rs]k_live_[A-Za-z0-9]{20,}\b/],
	["supabase-secret", /\bsb_secret_[A-Za-z0-9_-]{20,}\b/],
	["hardcoded-credential", /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];

function walk(root, limit = 4000) {
	const out = [];
	function visit(dir) {
		if (out.length >= limit) return;
		let entries = [];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (out.length >= limit) break;
			if (entry.name.startsWith(".") && !entry.name.startsWith(".env")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) visit(full); }
			else if (entry.isFile() && (entry.name.startsWith(".env") || TEXT_EXT.test(entry.name))) out.push(full);
		}
	}
	visit(path.resolve(root));
	return out;
}

function sourceScan(root) {
	const secrets = [], riskyInputs = [];
	for (const file of walk(root)) {
		let text = "";
		try { if (fs.statSync(file).size > 1024 * 1024) continue; text = fs.readFileSync(file, "utf8"); } catch { continue; }
		const rel = path.relative(root, file).replace(/\\/g, "/");
		let specificSecret = false;
		for (const [kind, re] of SECRET_PATTERNS) {
			if (kind === "hardcoded-credential" && specificSecret) continue;
			const match = text.match(re);
			if (match && !/example|placeholder|your[_-]|process\.env|import\.meta\.env/i.test(match[0])) { secrets.push({ file: rel, kind }); if (kind !== "hardcoded-credential") specificSecret = true; }
		}
		const checks = [
			["html-injection", /\b(?:innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML\s*=/],
			["dynamic-code", /\beval\s*\(|new\s+Function\s*\(/],
			["shell-exec", /\b(?:exec|execSync)\s*\([^\n]*(?:req\.|request\.|params|query|body)/i],
		];
		for (const [kind, re] of checks) if (re.test(text)) riskyInputs.push({ file: rel, kind });
	}
	return { secrets, riskyInputs };
}

function npmAudit(root) {
	if (!fs.existsSync(path.join(root, "package-lock.json")) && !fs.existsSync(path.join(root, "npm-shrinkwrap.json"))) return { status: "skipped", reason: "no npm lockfile", vulnerabilities: {} };
	const run = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["audit", "--json", "--omit=dev"], { cwd: root, encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
	let parsed = null;
	try { parsed = JSON.parse(run.stdout || "{}"); } catch { }
	const vulnerabilities = parsed && parsed.metadata && parsed.metadata.vulnerabilities;
	if (vulnerabilities) return { status: "complete", exitCode: run.status, vulnerabilities };
	return { status: "unavailable", reason: String(run.error && run.error.message || run.stderr || "npm audit returned no metadata").trim().slice(0, 300), vulnerabilities: {} };
}

function inspectHeaders(url, timeoutMs = 12000) {
	return new Promise((resolve) => {
		let target;
		try { target = new URL(url); } catch { return resolve({ status: "unavailable", reason: "invalid URL", headers: {}, missing: [] }); }
		const client = target.protocol === "https:" ? https : http;
		const req = client.get(target, { headers: { "user-agent": "Solstice-Security-Audit/1.0" } }, (res) => {
			res.resume();
			const required = ["content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy"];
			if (target.protocol === "https:") required.push("strict-transport-security");
			resolve({ status: "complete", statusCode: res.statusCode, headers: res.headers, missing: required.filter((key) => !res.headers[key]) });
		});
		req.setTimeout(timeoutMs, () => req.destroy(new Error("header probe timed out")));
		req.on("error", (error) => resolve({ status: "unavailable", reason: error.message, headers: {}, missing: [] }));
	});
}

async function auditSecurity(root, previewUrl, options = {}) {
	const source = sourceScan(root);
	const npm = options.skipNpm ? { status: "skipped", reason: "disabled by test", vulnerabilities: {} } : npmAudit(root);
	const headers = options.headers || await inspectHeaders(previewUrl);
	const vuln = npm.vulnerabilities || {};
	let score = 100;
	score -= Math.min(45, (vuln.critical || 0) * 20 + (vuln.high || 0) * 12 + (vuln.moderate || 0) * 5 + (vuln.low || 0) * 2);
	score -= Math.min(40, source.secrets.length * 20);
	score -= Math.min(20, source.riskyInputs.length * 5);
	if (headers.status === "complete") score -= Math.min(25, headers.missing.length * 5);
	else score -= 5;
	score = Math.max(0, score);
	const findings = [];
	for (const item of source.secrets) findings.push({ severity: "critical", check: "secret-scan", message: `${item.kind} detected in ${item.file}` });
	for (const item of source.riskyInputs) findings.push({ severity: "warning", check: "input-safety", message: `${item.kind} requires review in ${item.file}` });
	for (const key of headers.missing || []) findings.push({ severity: "warning", check: "headers", message: `Missing ${key}` });
	if ((vuln.critical || 0) + (vuln.high || 0)) findings.push({ severity: "critical", check: "npm-audit", message: `${vuln.critical || 0} critical and ${vuln.high || 0} high production vulnerabilities` });
	if (npm.status === "unavailable") findings.push({ severity: "info", check: "npm-audit", message: `Audit unavailable: ${npm.reason}` });
	return { createdAt: new Date().toISOString(), score, grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F", npm, headers: { status: headers.status, statusCode: headers.statusCode || null, missing: headers.missing || [], reason: headers.reason || null }, source, findings };
}

module.exports = { auditSecurity, inspectHeaders, npmAudit, sourceScan };
