#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { codexVersion, checkCodexModelCompatibility } = require("../src/stable/extensions/solstice-codex/codexCompatibility");
const { discoverCodexModels } = require("../src/stable/extensions/solstice-codex/modelDiscovery");

async function main() {
	const target = process.argv[2] || process.platform;
	const mode = process.argv[3] || "--require-models";
	if (!["--version-only", "--require-models"].includes(mode)) throw new Error(`unknown verification mode: ${mode}`);
	const expectedPlatform = target === "win32" ? "win32" : target === "darwin" ? "darwin" : target === "linux" ? "linux" : null;
	if (!expectedPlatform) throw new Error(`unknown target: ${target}`);
	if (process.platform !== expectedPlatform) throw new Error(`target ${target} cannot be executed on ${process.platform}`);

	const executable = target === "win32" ? "codex.exe" : "codex";
	const binary = path.join(__dirname, "..", "src", "stable", "extensions", "solstice-codex", "bin", executable);
	if (!fs.existsSync(binary)) throw new Error(`bundled Codex binary is missing: ${binary}`);

	const version = codexVersion(binary);
	if (!version.ok) throw new Error(`bundled Codex version probe failed: ${version.output || version.error || "unknown error"}`);
	const compatibility = checkCodexModelCompatibility("gpt-5.6-sol", binary, () => version);
	if (!compatibility.ok) throw new Error(compatibility.message);
	if (mode === "--version-only") {
		console.log(JSON.stringify({
			target,
			version: version.output,
			minimum: compatibility.required,
			catalogCheck: "deferred to authenticated machine acceptance",
		}, null, 2));
		return;
	}

	// model/list is entitlement-aware and can block on a clean CI runner with
	// no Codex login. Require it only in the authenticated acceptance probe.
	const models = await discoverCodexModels(binary, 20000);
	const ids = models.map((model) => model.modelId);
	for (const required of ["gpt-5.6-sol", "gpt-5.6-terra"]) {
		if (!ids.includes(required)) throw new Error(`Codex model/list omitted ${required}; returned: ${ids.join(", ") || "<empty>"}`);
	}

	console.log(JSON.stringify({ target, version: version.output, required: ["gpt-5.6-sol", "gpt-5.6-terra"], models: ids }, null, 2));
}

main().catch((error) => {
	console.error(error && error.stack || error);
	process.exitCode = 1;
});
