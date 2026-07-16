"use strict";

const fs = require("fs");
const path = require("path");

function safeId(value) {
	return String(value || "build").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "build";
}

function normalizeBrowserReport(input) {
	const report = input && typeof input === "object" ? input : {};
	const findings = Array.isArray(report.findings) ? report.findings.map((finding) => ({
		severity: finding && finding.severity === "warning" ? "warning" : "error",
		check: String(finding && finding.check || "browser").slice(0, 80),
		message: String(finding && finding.message || "Unknown browser finding").replace(/[\r\n]+/g, " ").slice(0, 600),
		evidence: finding && finding.evidence && typeof finding.evidence === "object" ? finding.evidence : {},
	})) : [];
	const errors = findings.filter((finding) => finding.severity === "error");
	return {
		...report,
		ok: report.ok === true && errors.length === 0,
		checkedAt: String(report.checkedAt || new Date().toISOString()),
		url: String(report.url || ""),
		summary: report.summary && typeof report.summary === "object" ? report.summary : {},
		findings,
	};
}

function selfCheckRoundDir(root, buildId, round) {
	return path.join(path.resolve(root), ".solstice", "self-check", safeId(buildId), `round-${Math.max(1, Number(round) || 1)}`);
}

function writeBrowserSelfCheckReport(root, buildId, round, input) {
	const report = normalizeBrowserReport(input);
	const dir = selfCheckRoundDir(root, buildId, round);
	fs.mkdirSync(dir, { recursive: true });
	const payload = { ...report, buildId: safeId(buildId), round: Math.max(1, Number(round) || 1) };
	const body = JSON.stringify(payload, null, 2) + "\n";
	const file = path.join(dir, "report.json");
	const latest = path.join(path.resolve(root), ".solstice", "self-check", "latest.json");
	for (const target of [file, latest]) {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(temp, body, { mode: 0o600 });
		fs.renameSync(temp, target);
	}
	return { report: payload, dir, file, latest };
}

function buildBrowserFixPrompt(input, round, maxRounds) {
	const report = normalizeBrowserReport(input);
	const items = report.findings.filter((finding) => finding.severity === "error").slice(0, 24);
	const lines = items.map((finding, index) => `${index + 1}. [${finding.check}] ${finding.message}`);
	return [
		"[FELIX_BROWSER_SELF_CHECK]",
		`Browser self-check round ${round}/${maxRounds} failed on ${report.url || "the live preview"}.`,
		"Fix every concrete browser finding below in the application source. Do not merely explain or suppress it.",
		...lines,
		"Run focused source tests where relevant, keep the dev server alive, and finish the turn. Felix will reopen the real browser and rerun the full navigation/control/form/console/404/layout check automatically.",
		"Do not claim delivery is complete until a later [FELIX_BROWSER_SELF_CHECK_GREEN] result is injected.",
		"[/FELIX_BROWSER_SELF_CHECK]",
	].join("\n");
}

module.exports = {
	safeId,
	normalizeBrowserReport,
	selfCheckRoundDir,
	writeBrowserSelfCheckReport,
	buildBrowserFixPrompt,
};
