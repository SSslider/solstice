"use strict";

const assert = require("assert");
const { MODEL_REGISTRY } = require("./grok");
const { parseGrokModels, parseCodexModelList, selectCodexDefault, groupModels } = require("./modelDiscovery");

const grok = parseGrokModels(`Available models:\n  * grok-composer-2.5-fast (default)\n  - grok-4.5\n`);
assert.deepEqual(grok.map((model) => model.key), ["composer-2.5", "grok-4.5"]);
assert.deepEqual(grok.map((model) => model.provider), ["composer", "grok"]);
assert.deepEqual(grok.map((model) => model.isDefault), [true, false]);
assert.equal(grok.some((model) => /4\.3/.test(model.key)), false);

const codex = parseCodexModelList({ data: [
	{ model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Frontier", hidden: false, isDefault: true },
	{ model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", hidden: false },
	{ model: "legacy-hidden", displayName: "Legacy", hidden: true },
] });
assert.deepEqual(codex.map((model) => model.key), ["gpt-5.6-sol", "gpt-5.6-terra"]);
assert.ok(codex.every((model) => model.provider === "gpt" && model.runner === "codex"));
assert.equal(selectCodexDefault(codex), "gpt-5.6-sol");
assert.equal(selectCodexDefault(parseCodexModelList({ defaultModel: "gpt-6-astra", data: [{ model: "gpt-5.6-sol" }, { model: "gpt-6-astra" }] })), "gpt-6-astra");
assert.equal(selectCodexDefault(parseCodexModelList({ data: [{ model: "first-live-model" }, { model: "second-live-model" }] })), "first-live-model");
assert.equal(selectCodexDefault([]), "");

const closed = groupModels([...codex, ...grok], false);
assert.deepEqual(closed.map((group) => group.key), ["gpt", "grok", "composer"]);
assert.equal(closed.some((group) => group.key === "claude"), false);

const claudeModels = Object.entries(MODEL_REGISTRY)
	.filter(([, model]) => model.runner === "claude")
	.map(([key, model]) => ({ key, modelId: model.claudeId, label: model.label, runner: model.runner, provider: model.provider, manualOnly: model.manualOnly }));
const open = groupModels([...codex, ...grok, ...claudeModels], true);
const claude = open.find((group) => group.key === "claude");
assert.deepEqual(claude.models.map((model) => model.key), ["claude-opus-5", "claude-fable-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]);
assert.ok(claude.models.every((model) => model.manualOnly));
assert.equal(groupModels([...codex, ...grok, ...claude.models], true).find((group) => group.key === "claude").models.length, 6);
assert.deepEqual(claudeModels.map((model) => model.modelId), ["claude-opus-5", "claude-fable-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]);
const withMoonshot = groupModels([...codex, ...grok, ...claudeModels, { key: "kimi-k3", modelId: "kimi-k3", label: "Kimi K3", runner: "moonshot", provider: "moonshot" }], true);
assert.deepEqual(withMoonshot.map((group) => group.key), ["gpt", "grok", "composer", "claude", "moonshot"]);
assert.equal(withMoonshot.at(-1).models[0].key, "kimi-k3");

console.log("modelDiscovery.test.js: 18/18 checks passed");
