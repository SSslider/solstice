"use strict";

const { spawnSync } = require("child_process");
const { resolveWinSpawn } = require("./winspawn");

const GPT_56_MIN_CODEX_VERSION = "0.144.0";

function parseVersion(text) {
	const match = String(text || "").match(/(?:codex-cli\s+)?v?(\d+)\.(\d+)\.(\d+)/i);
	return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
	const a = Array.isArray(left) ? left : parseVersion(left);
	const b = Array.isArray(right) ? right : parseVersion(right);
	if (!a || !b) return null;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
	}
	return 0;
}

function codexVersion(bin) {
	try {
		const plan = resolveWinSpawn(bin, ["--version"]);
		const result = spawnSync(plan.cmd, plan.args, {
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
			env: plan.env || process.env,
		});
		const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
		const parsed = parseVersion(output);
		return { ok: !result.error && result.status === 0 && !!parsed, output, parsed, error: result.error || null };
	} catch (error) {
		return { ok: false, output: "", parsed: null, error };
	}
}

function checkCodexModelCompatibility(model, bin, versionReader = codexVersion) {
	if (model !== "gpt-5.6") return { ok: true, model };
	const current = versionReader(bin);
	const installed = current && current.parsed ? current.parsed.join(".") : "unknown";
	const comparison = current && current.parsed ? compareVersions(current.parsed, GPT_56_MIN_CODEX_VERSION) : null;
	if (current && current.ok && comparison !== null && comparison >= 0) {
		return { ok: true, model, installed, required: GPT_56_MIN_CODEX_VERSION };
	}
	return {
		ok: false,
		model,
		installed,
		required: GPT_56_MIN_CODEX_VERSION,
		message: `GPT-5.6 requires Codex CLI >=${GPT_56_MIN_CODEX_VERSION}; installed: ${installed}. Run npm i -g @openai/codex@latest, then point solstice.codex.path at the upgraded codex binary.`,
	};
}

module.exports = {
	GPT_56_MIN_CODEX_VERSION,
	parseVersion,
	compareVersions,
	codexVersion,
	checkCodexModelCompatibility,
};
