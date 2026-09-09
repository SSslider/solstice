#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

function verifyRuntime(root, target) {
	const targets = { win32: "x86_64-pc-windows-msvc", darwin: "aarch64-apple-darwin", linux: "x86_64-unknown-linux-musl" };
	if (!targets[target]) throw new Error(`Unknown Codex runtime target: ${target}`);
	const suffix = target === "win32" ? ".exe" : "";
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "codex-package.json"), "utf8"));
	if (manifest.layoutVersion !== 1 || manifest.version !== "0.153.3" || manifest.variant !== "codex" || manifest.target !== targets[target] ||
		manifest.entrypoint !== `bin/codex${suffix}` || manifest.pathDir !== "codex-path" || manifest.resourcesDir !== "codex-resources") {
		throw new Error("Unexpected Codex runtime layout, version or target");
	}
	const files = [`bin/codex${suffix}`, `bin/codex-code-mode-host${suffix}`, `codex-path/rg${suffix}`];
	if (target === "win32") files.push("codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe");
	else {
		files.push("codex-resources/zsh/bin/zsh");
		if (target === "linux") files.push("codex-resources/bwrap");
	}
	for (const relative of files) {
		const file = path.join(root, relative);
		if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`Codex runtime dependency missing: ${relative}`);
	}
	return { target, version: manifest.version, files, complete: true };
}

if (require.main === module) {
	try { console.log(JSON.stringify(verifyRuntime(process.argv[2], process.argv[3]), null, 2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifyRuntime };
