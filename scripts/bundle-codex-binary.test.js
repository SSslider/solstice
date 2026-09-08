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

console.log("bundle-codex-binary.test.js: 18/18 checks passed");
