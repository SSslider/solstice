"use strict";

const assert = require("assert");
const { parseGrokModels, parseCodexModelList, groupModels } = require("./modelDiscovery");

const grok = parseGrokModels(`Available models:\n  * grok-composer-2.5-fast (default)\n  - grok-4.5\n`);
assert.deepEqual(grok.map((model) => model.key), ["composer-2.5", "grok-4.5"]);
assert.deepEqual(grok.map((model) => model.provider), ["composer", "grok"]);
assert.deepEqual(grok.map((model) => model.isDefault), [true, false]);
assert.equal(grok.some((model) => /4\.3/.test(model.key)), false);

const codex = parseCodexModelList({ data: [
	{ model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Frontier", hidden: false },
	{ model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", hidden: false },
	{ model: "legacy-hidden", displayName: "Legacy", hidden: true },
] });
assert.deepEqual(codex.map((model) => model.key), ["gpt-5.6-sol", "gpt-5.6-terra"]);
assert.ok(codex.every((model) => model.provider === "gpt" && model.runner === "codex"));

const closed = groupModels([...codex, ...grok], false);
assert.deepEqual(closed.map((group) => group.key), ["gpt", "grok", "composer"]);
assert.equal(closed.some((group) => group.key === "claude"), false);

const open = groupModels([...codex, ...grok], true);
const claude = open.find((group) => group.key === "claude");
assert.deepEqual(claude.models.map((model) => model.key), ["claude-opus", "claude-sonnet"]);
assert.ok(claude.models.every((model) => model.manualOnly));
assert.equal(groupModels([...codex, ...grok, ...claude.models], true).find((group) => group.key === "claude").models.length, 2);

console.log("modelDiscovery.test.js: 11/11 checks passed");
