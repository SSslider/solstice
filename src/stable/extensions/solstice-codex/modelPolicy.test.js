"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const grok = fs.readFileSync(path.join(__dirname, "grok.js"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "media", "panel.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

assert.match(extension, /runnerFor\(k\) === "claude"[\s\S]{0,160}!this\._manualClaudeSelected/);
assert.doesNotMatch(extension, /last resort:[^\n]*claude/);
assert.match(extension, /failoverChain\(\)[\s\S]{0,500}runnerFor\(k\) !== "claude"/);
assert.doesNotMatch(extension.match(/suggestFallback\(\)[\s\S]*?\n\t}/)[0], /Claude Code/);
assert.match(extension, /model:\s*selected\.claudeId \|\| undefined/);
assert.match(grok, /"claude-opus"[\s\S]{0,180}manualOnly:\s*true/);
assert.match(grok, /"claude-sonnet"[\s\S]{0,180}manualOnly:\s*true/);
assert.match(panel, /modelProviderKey[\s\S]{0,1800}Providers/);
assert.equal(pkg.contributes.configuration.properties["solstice.codex.provider"].default, "composer-2.5");
assert.equal(pkg.contributes.configuration.properties["solstice.codex.provider"].enum, undefined);

console.log("modelPolicy.test.js: 10/10 checks passed");
