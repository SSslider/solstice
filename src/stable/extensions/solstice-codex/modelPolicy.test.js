"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const grok = fs.readFileSync(path.join(__dirname, "grok.js"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "media", "panel.js"), "utf8");
const moonshot = fs.readFileSync(path.join(__dirname, "moonshot.js"), "utf8");
const onboarding = fs.readFileSync(path.join(__dirname, "providerOnboarding.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

assert.match(extension, /runnerFor\(k\) === "claude"[\s\S]{0,160}!this\._manualClaudeSelected/);
assert.match(extension, /"claude-opus":\s*"claude-opus-4-8"/);
assert.match(extension, /"claude-sonnet":\s*"claude-sonnet-5"/);
assert.doesNotMatch(extension, /last resort:[^\n]*claude/);
assert.match(extension, /failoverChain\(\)[\s\S]{0,500}!\(MODEL_REGISTRY\[k\] && MODEL_REGISTRY\[k\]\.manualOnly\)/);
assert.doesNotMatch(extension.match(/suggestFallback\(\)[\s\S]*?\n\t}/)[0], /Claude Code/);
assert.match(extension, /model:\s*selected\.claudeId \|\| undefined/);
assert.match(grok, /"claude-fable-5"[\s\S]{0,220}claudeId:\s*"claude-fable-5"[\s\S]{0,180}manualOnly:\s*true/);
assert.match(grok, /"claude-opus-4-8"[\s\S]{0,220}claudeId:\s*"claude-opus-4-8"[\s\S]{0,180}manualOnly:\s*true/);
assert.match(grok, /"claude-opus-4-7"[\s\S]{0,220}claudeId:\s*"claude-opus-4-7"[\s\S]{0,180}manualOnly:\s*true/);
assert.match(grok, /"claude-sonnet-5"[\s\S]{0,220}claudeId:\s*"claude-sonnet-5"[\s\S]{0,180}manualOnly:\s*true/);
assert.match(grok, /"kimi-k3"[\s\S]{0,220}runner:\s*"moonshot"[\s\S]{0,180}manualOnly:\s*true/);
assert.match(extension, /ensureProviderConnection\(vscode, this\.context, "moonshot"/);
assert.match(onboarding, /https:\/\/api\.moonshot\.ai\/v1/);
assert.doesNotMatch(moonshot + onboarding + extension, /openrouter\.ai/i);
assert.match(panel, /modelProviderKey[\s\S]{0,1800}Providers/);
assert.equal(pkg.contributes.configuration.properties["solstice.codex.provider"].default, "composer-2.5");
assert.equal(pkg.contributes.configuration.properties["solstice.codex.provider"].enum, undefined);
assert.equal(pkg.contributes.configuration.properties["solstice.codex.allowClaude"].default, true);

console.log("modelPolicy.test.js: 19/19 checks passed");
