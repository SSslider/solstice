"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "bundle-codex-binary.sh"), "utf8");
const verifier = fs.readFileSync(path.join(__dirname, "verify-bundled-codex-models.js"), "utf8");
const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-solstice.yml"), "utf8");
const version = /CODEX_VERSION="rust-v(\d+)\.(\d+)\.(\d+)"/.exec(source);
assert.ok(version, "bundle script must pin an explicit stable Codex release");
const parsed = version.slice(1).map(Number);
assert.ok(parsed[0] > 0 || parsed[1] >= 153, `bundled Codex ${parsed.join(".")} is too old for GPT-6`);

for (const target of ["win32", "darwin", "linux"]) {
	assert.match(source, new RegExp(`${target}\\).*EXPECTED_SHA256="[a-f0-9]{64}"`), `${target} asset must have a pinned SHA-256`);
}
assert.match(source, /sha256sum/);
assert.match(source, /shasum -a 256/);
assert.match(source, /does not satisfy GPT-6 minimum \(>=0\.153\.0\)/);
assert.match(source, /grep -aFq -- "gpt-6-astra"/);
assert.match(source, /bundled Codex binary is missing required model capability: gpt-6-astra/);
assert.match(verifier, /\["gpt-6-astra", "gpt-5\.6-sol", "gpt-5\.6-terra"\]/);
assert.match(verifier, /GPT_6_MIN_CODEX_VERSION = "0\.153\.0"/);
assert.match(verifier, /--version-only/);
assert.match(verifier, /--require-models/);
assert.match(verifier, /deferred to authenticated machine acceptance/);
for (const target of ["win32", "darwin", "linux"]) {
	assert.match(workflow, new RegExp(`node scripts/verify-bundled-codex-models\\.js ${target} --version-only`), `${target} build must verify the bundled Codex version`);
}

const os = require("os");
const { verifyRuntime } = require("./verify-codex-runtime");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-contract-"));
let checks = 18;
try {
	for (const [target, triple] of Object.entries({ win32: "x86_64-pc-windows-msvc", darwin: "aarch64-apple-darwin", linux: "x86_64-unknown-linux-musl" })) {
		const dir = path.join(root, target), suffix = target === "win32" ? ".exe" : "";
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version: "0.153.3", target: triple, variant: "codex", entrypoint: `bin/codex${suffix}`, pathDir: "codex-path", resourcesDir: "codex-resources" }));
		const files = [`bin/codex${suffix}`, `bin/codex-code-mode-host${suffix}`, `codex-path/rg${suffix}`,
			...(target === "win32" ? ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"] : ["codex-resources/zsh/bin/zsh", ...(target === "linux" ? ["codex-resources/bwrap"] : [])])];
		for (const name of files) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), "fixture"); }
		assert.equal(verifyRuntime(dir, target).complete, true); checks++;
		for (const name of files) {
			fs.unlinkSync(path.join(dir, name));
			assert.throws(() => verifyRuntime(dir, target), /dependency missing/, `${target} must reject missing ${name}`); checks++;
			fs.writeFileSync(path.join(dir, name), "fixture");
		}
		assert.throws(() => verifyRuntime(dir, target === "win32" ? "linux" : "win32"), /layout, version or target/); checks++;
		assert.match(workflow, new RegExp(`Verify packaged Codex runtime \\(${target}\\)`)); checks++;
	}
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`bundle-codex-binary.test.js: ${checks}/${checks} checks passed`);
