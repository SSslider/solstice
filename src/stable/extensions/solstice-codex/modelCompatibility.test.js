"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
	GPT_56_MIN_CODEX_VERSION,
	parseVersion,
	compareVersions,
	checkCodexModelCompatibility,
} = require("./codexCompatibility");
const { isPureLaunchIntent } = require("./intent");

assert.deepEqual(parseVersion("codex-cli 0.144.0"), [0, 144, 0]);
assert.equal(compareVersions("0.143.9", GPT_56_MIN_CODEX_VERSION), -1);
assert.equal(compareVersions("0.144.0", GPT_56_MIN_CODEX_VERSION), 0);
assert.equal(compareVersions("0.145.0", GPT_56_MIN_CODEX_VERSION), 1);
assert.equal(checkCodexModelCompatibility("gpt-5.5", "codex", () => { throw new Error("must not run"); }).ok, true);

const oldCli = checkCodexModelCompatibility("gpt-5.6", "codex", () => ({ ok: true, parsed: [0, 137, 0] }));
assert.equal(oldCli.ok, false);
assert.match(oldCli.message, />=0\.144\.0/);
assert.match(oldCli.message, /npm i -g @openai\/codex@latest/);
assert.equal(checkCodexModelCompatibility("gpt-5.6", "codex", () => ({ ok: true, parsed: [0, 144, 0] })).ok, true);
assert.equal(checkCodexModelCompatibility("gpt-5.6-sol", "codex", () => ({ ok: true, parsed: [0, 143, 9] })).ok, false);
assert.equal(checkCodexModelCompatibility("gpt-5.6-terra", "codex", () => ({ ok: true, parsed: [0, 144, 0] })).ok, true);
assert.equal(isPureLaunchIntent("פתח את האתר"), true);
assert.equal(isPureLaunchIntent("הרץ את האפליקציה"), true);
assert.equal(isPureLaunchIntent("open the website"), true);
assert.equal(isPureLaunchIntent("פתח ובנה אתר חדש"), false);

const grok = fs.readFileSync(path.join(__dirname, "grok.js"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
assert.match(grok, /"gpt-5\.6"[\s\S]{0,180}codexId:\s*"gpt-5\.6"/);
assert.match(grok, /"grok-4\.5"[\s\S]{0,180}label:\s*"Grok 4\.5 Build"[\s\S]{0,180}grokId:\s*"grok-4\.5"/);
assert.match(extension, /isPureLaunchIntent/);
assert.deepEqual(pkg.contributes.configuration.properties["solstice.codex.failoverChain"].default, ["gpt-5.5"]);

console.log("modelCompatibility.test.js: 19/19 checks passed");
